#!/usr/bin/env node
/**
 * Detect (and, where the host allows it, unwrap) an assistant response that arrived as a
 * serialization envelope instead of plain text.
 *
 * The failure looks like this, and nests:
 *
 *     {"text": "[{\"text\": \"...\", \"type\": \"text\"}]", "type": "text"}
 *
 * Why a script and not a regex in a rule: the user cannot read the answer through the envelope, and
 * telling a model "do not wrap" has failed repeatedly. A rule is advice; this runs whether or not
 * anything was remembered.
 *
 * The important half is the negative case. Markdown routinely contains JSON — a fenced example, a
 * payload in an API description — and firing on that would inject feedback after every correct
 * answer. Detection therefore only triggers when the *entire* trimmed response parses as an envelope.
 *
 * Usage:
 *   node detect-json-wrapper.mjs --check "<response text>"
 *   echo '<hook json>' | node detect-json-wrapper.mjs --hook
 */

const ENVELOPE_KEYS = new Set(['text', 'type']);

function isEnvelopeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > ENVELOPE_KEYS.size) return false;
    // `type` must be the literal the IDE uses, and `text` must be a string. A generic `{ text }`
    // object from an API sample is not this bug.
    if (value.type !== undefined && value.type !== 'text') return false;
    if (typeof value.text !== 'string') return false;
    return keys.every((k) => ENVELOPE_KEYS.has(k));
}

function isEnvelopeArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every(isEnvelopeObject);
}

/** True when `value` is an envelope object, an envelope array, or a JSON string holding one. */
function isEnvelope(value, depth = 0) {
    if (depth > 8) return false;
    if (isEnvelopeObject(value) || isEnvelopeArray(value)) return true;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
        try {
            return isEnvelope(JSON.parse(trimmed), depth + 1);
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * @param {string} response the assistant's final message
 * @returns {boolean} true only when the whole response is an envelope
 */
export function detectWrappedOutput(response) {
    if (typeof response !== 'string') return false;
    const trimmed = response.trim();
    if (!trimmed) return false;
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return false;
    }
    return isEnvelope(parsed);
}

/**
 * Peel envelopes until plain text is left. Terminates on malformed input: each step must yield a
 * strictly shorter string, and the depth is capped.
 *
 * @param {string} response
 * @returns {string} plain text (unchanged when the input was never an envelope)
 */
export function unwrapWrappedOutput(response) {
    if (typeof response !== 'string') return '';
    let current = response;
    for (let depth = 0; depth < 8; depth += 1) {
        const trimmed = current.trim();
        if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return current;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return current;
        }
        if (isEnvelopeArray(parsed)) {
            const next = parsed.map((p) => p.text).join('');
            if (next.length === 0 || next === current) return current;
            current = next;
            continue;
        }
        if (isEnvelopeObject(parsed)) {
            const next = parsed.text;
            if (next.length === 0 || next === current) return current;
            current = next;
            continue;
        }
        return current;
    }
    return current;
}

function main(argv) {
    const mode = argv[2];
    if (mode === '--check') {
        const text = argv[3] ?? '';
        const wrapped = detectWrappedOutput(text);
        if (wrapped) {
            process.stdout.write(unwrapWrappedOutput(text));
            process.exitCode = 1;
        } else {
            process.stdout.write(text);
            process.exitCode = 0;
        }
        return;
    }
    if (mode === '--hook') {
        let raw = '';
        process.stdin.on('data', (d) => (raw += d)).on('end', () => {
            let payload = {};
            try {
                payload = JSON.parse(raw || '{}');
            } catch {
                /* a hook that cannot read its input must not break the turn */
            }
            const response = payload.response ?? payload.text ?? payload.message ?? '';
            const wrapped = detectWrappedOutput(String(response));
            // `afterAgentResponse` supports `agent_message`. Fail open: when the host does not act on
            // it, the hook is a no-op rather than a blocker.
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
        });
        return;
    }
    process.stderr.write('usage: detect-json-wrapper.mjs --check "<text>" | --hook < payload.json\n');
    process.exitCode = 2;
}

// Only run as a CLI. Importing this module (from qc tests) must not read stdin or exit.
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
