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

/** Best-effort audit trail; the guard must work when `.cursor/session/` is not writable. */
function record(payload) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.appendFileSync(STATE_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
    } catch {
        /* observability, never a blocker */
    }
}

/**
 * @param {object} payload the `stop` event input
 * @returns {{ followup_message?: string }}
 */
export function stopVerdict(payload) {
    const status = typeof payload.status === 'string' ? payload.status : 'completed';
    if (status !== 'completed') return {};
    const attempts = Number.isFinite(payload.loop_count) ? Number(payload.loop_count) + 1 : 1;
    const { wrapped } = inspectAgentText(extractResponseText(payload));
    if (!wrapped) return {};
    record({ event: 'wrap-detected', attempt: attempts });
    if (attempts >= MAX_ATTEMPTS) {
        record({ event: 'wrap-unresolved', attempt: attempts });
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
