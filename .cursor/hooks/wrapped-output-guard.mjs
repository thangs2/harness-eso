/**
 * Turn-end guard for a reply that reached the user as a serialization envelope.
 *
 * Why this hook and not `afterAgentResponse`: Cursor's reference lists `afterAgentResponse` as an
 * observation event with **no output fields**, so an `agent_message` sent from it is discarded — the
 * previous version of this guard was a no-op on the live host. `stop` is the event that can act: a
 * non-empty `followup_message` is submitted as the next turn.
 *
 * That power is why the detector is narrow. A follow-up is a whole extra round trip, so a false
 * positive costs the user a turn; the shared detector in `lib/agent-response.mjs` therefore only
 * fires when the *entire* message is an envelope (or its peeled outer layer is). Ordinary markdown
 * that happens to contain a JSON block never reaches `followup_message`.
 *
 * `loop_limit` in `.cursor/hooks.json` caps consecutive follow-ups so a model that keeps wrapping
 * cannot spin: the second wrap in a row is logged, not retried.
 *
 * Usage:
 *   echo '{"status":"completed","loop_count":0}' | node .cursor/hooks/wrapped-output-guard.mjs --stop
 *   echo '{"text":"..."}' | node .cursor/hooks/detect-json-wrapper.mjs --hook
 *   node .cursor/hooks/detect-json-wrapper.mjs --check "<response text>"
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractResponseText, inspectAgentText, REMINDER } from './lib/agent-response.mjs';

/** One retry; a second wrap in a row is evidence the reminder is not landing, not something to loop on. */
const MAX_ATTEMPTS = 2;

/**
 * Two `stop` events closer together than this are the same turn being re-checked, not a resend.
 *
 * This window exists because `loop_count` is not a turn counter: it only appears after a follow-up has
 * already been refused, so on the resend turn it is absent and `attempts` was computed as 1 again. The
 * 2026-10-23 audit trail showed the consequence — 73 `wrap-detected` in two days, of which 36 were the
 * same check firing twice **1 ms apart**, so `MAX_ATTEMPTS` never held and the retry budget was spent
 * on a second reminder instead of on the resend.
 */
const SAME_TURN_MS = 5_000;

const STATE_FILE = path.join('.cursor', 'session', 'wrapped-output.json');

function readStdin() {
    return new Promise((resolve) => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (raw += d)).on('end', () => resolve(raw)).on('error', () => resolve(''));
    });
}

function readJson(raw) {
    try {
        const value = JSON.parse(raw || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        // A hook that cannot read its input must not break the turn.
        return {};
    }
}

/**
 * Append one trail entry.
 *
 * The stamp is taken from the caller's clock, not `new Date()`: `stopVerdict` compares this timestamp
 * against `opts.now`, and two clocks in one decision is how the resend check silently stopped firing.
 */
function record(payload, file = STATE_FILE, now = Date.now()) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...payload })}\n`);
    } catch {
        /* observability, never a blocker */
    }
}

/**
 * The most recent wrap recorded, or `null` when the trail is unreadable/absent.
 *
 * `stop` never received a working turn counter, so the trail is the only evidence of "this is the
 * resend, not the first wrap". A missing file must read as "no previous wrap" — the guard's job is to
 * ask for a resend, and refusing to ask because it cannot read its own history would be the worse bug.
 *
 * @param {string} [file]
 * @param {number} [now]
 */
function lastWrap(file = STATE_FILE, now = Date.now()) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || entry.event !== 'wrap-detected') continue;
        const at = Date.parse(entry.at);
        return { at: Number.isFinite(at) ? at : 0, recent: now - at < SAME_TURN_MS };
    }
    return null;
}

/**
 * @param {object} payload the `stop` event input
 * @param {{ stateFile?: string, now?: number }} [opts] test seams
 * @returns {{ followup_message?: string }}
 */
export function stopVerdict(payload, opts = {}) {
    const now = opts.now ?? Date.now();
    const status = typeof payload.status === 'string' ? payload.status : 'completed';
    if (status !== 'completed') return {};
    const { wrapped } = inspectAgentText(extractResponseText(payload));
    if (!wrapped) return {};
    /*
     * Attempt count = how many wraps the *conversation* has produced. `loop_count` is used when the
     * host supplies it; otherwise the trail decides, and a wrap recorded moments ago means the resend
     * we already asked for came back wrapped too — so the reminder is not landing and must not repeat.
     */
    const previous = lastWrap(opts.stateFile, now);
    const attempts =
        (Number.isFinite(payload.loop_count) ? Number(payload.loop_count) : 0) +
        (previous?.recent ? 1 : 0) +
        1;
    record({ event: 'wrap-detected', attempt: attempts }, opts.stateFile, now);
    if (attempts >= MAX_ATTEMPTS) {
        record({ event: 'wrap-unresolved', attempt: attempts }, opts.stateFile, now);
        return {};
    }
    return { followup_message: REMINDER };
}

async function main(argv) {
    const mode = argv[2];
    if (mode === '--check') {
        const text = argv[3] ?? '';
        const { wrapped, peeled } = inspectAgentText(text);
        process.stdout.write(wrapped ? peeled : text);
        process.exitCode = wrapped ? 1 : 0;
        return;
    }
    if (mode === '--stop') {
        process.stdout.write(JSON.stringify(stopVerdict(readJson(await readStdin()))));
        return;
    }
    if (mode === '--hook') {
        // Kept for `afterAgentResponse`: detection only. The host ignores output on that event, so this
        // path exists to be observable (Hooks output channel) and to stay compatible with hosts that do
        // act on `agent_message`.
        const payload = readJson(await readStdin());
        const { wrapped } = inspectAgentText(extractResponseText(payload));
        if (wrapped) record({ event: 'wrap-detected', via: 'afterAgentResponse' });
        process.stdout.write(
            JSON.stringify(
                wrapped
                    ? {
                          agent_message:
                              'Your previous reply was sent inside a serialization envelope ({text,type}) and the user could not read it. Reply again with plain markdown, direct text only — no JSON object or array wrapping.',
                      }
                    : {},
            ),
        );
        return;
    }
    process.stderr.write(
        'usage: wrapped-output-guard.mjs --stop < payload.json | --check "<text>" | detect-json-wrapper.mjs --hook < payload.json\n',
    );
    process.exitCode = 2;
}

// Only run as a CLI. Importing this module (from qc tests) must not read stdin or exit.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    main(process.argv);
}
