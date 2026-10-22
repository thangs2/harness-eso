/**
 * What Cursor sends to `afterAgentResponse`, and what an envelope actually looks like once it has
 * been through the host.
 *
 * Two facts decided this file's shape, both checked against the live host rather than assumed:
 *
 *  1. **The host unescapes once.** Its input is `{ text }`, where `text` is the assistant message.
 *     A message that *arrived* wrapped as `{"text": "[{\"text\": \"hi\"}]", "type": "text"}` therefore
 *     reaches the hook as an object whose `text` field is already the plain string
 *     `[{"text": "hi"}]`. The wrapper is gone by the time we see it, so there is nothing to unwrap —
 *     only the *next* turn can be corrected.
 *  2. **`afterAgentResponse` supports no output fields.** Per Cursor's hook reference it is an
 *     observation event: stdin `{ text }`, empty output. A reply sent from it is discarded, which is
 *     what made the previous `agent_message` answer a no-op.
 *
 * So this module is the *detector* only, and it must be shared: the same verdict drives the turn-end
 * reminder (`stop`, which can submit a follow-up) and the transcript audit in `qc/`. One detector
 * means the audit and the guard can never disagree about what counts as wrapped.
 *
 * The important half is still the negative case. Markdown routinely contains JSON — a fenced example,
 * a payload in an API description — and firing on that would inject "you were wrapped" feedback into
 * every correct answer. Detection therefore only triggers when the *entire* trimmed text is an
 * envelope, or when the whole text is exactly a stringification of one (the host-unescaped shape).
 */

const ENVELOPE_KEYS = new Set(['text', 'type']);

/** Envelope `type` values seen from the host. Anything else (`"delta"`, `"tool_use"`, …) is not this bug. */
const KNOWN_TYPES = new Set(['text', 'output_text', 'message']);

function isEnvelopeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > ENVELOPE_KEYS.size) return false;
    // `type` must be one of the literals the host uses, and `text` must be a string. A generic
    // `{ text }` object from an API sample is not this bug.
    if (value.type !== undefined && !KNOWN_TYPES.has(value.type)) return false;
    if (typeof value.text !== 'string') return false;
    return keys.every((k) => ENVELOPE_KEYS.has(k));
}

function isEnvelopeArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every(isEnvelopeObject);
}

function parseIfJson(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    } catch {
        return { ok: false };
    }
}

/** True when `value` is an envelope object, an envelope array, or a JSON string holding one. */
function isEnvelope(value, depth = 0) {
    if (depth > 8) return false;
    if (isEnvelopeObject(value) || isEnvelopeArray(value)) return true;
    if (typeof value === 'string') {
        const parsed = parseIfJson(value);
        return parsed.ok ? isEnvelope(parsed.value, depth + 1) : false;
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
    const parsed = parseIfJson(trimmed);
    return parsed.ok && isEnvelope(parsed.value);
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
        const parsed = parseIfJson(trimmed);
        if (!parsed.ok) return current;
        if (isEnvelopeArray(parsed.value)) {
            const next = parsed.value.map((p) => p.text).join('');
            if (next.length === 0 || next === current) return current;
            current = next;
            continue;
        }
        if (isEnvelopeObject(parsed.value)) {
            const next = parsed.value.text;
            if (next.length === 0 || next === current) return current;
            current = next;
            continue;
        }
        return current;
    }
    return current;
}

/**
 * The assistant text out of a hook payload. Cursor sends `{ text }`; older/other hosts used
 * `response`, `message` or a nested `event`. Missing every key yields `''`, which detects as clean —
 * a hook that cannot read its input must not accuse the model.
 */
export function extractResponseText(payload) {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object') return '';
    for (const key of ['text', 'response', 'message', 'content']) {
        if (typeof payload[key] === 'string') return payload[key];
    }
    if (payload.event && typeof payload.event === 'object') return extractResponseText(payload.event);
    return '';
}

/**
 * `wrapped` is true when the text is an envelope, or when peeling its outer layer reveals one that
 * the host had escaped (a clean reply cannot peel, so the second case only fires on a real wrap).
 *
 * @param {string} text
 * @returns {{ wrapped: boolean, peeled: string }}
 */
export function inspectAgentText(text) {
    if (detectWrappedOutput(text)) return { wrapped: true, peeled: unwrapWrappedOutput(text) };
    const peeled = unwrapWrappedOutput(text);
    return { wrapped: peeled !== text && detectWrappedOutput(peeled), peeled };
}

/**
 * What the agent should hear at turn end. Deliberately short: it is submitted as a follow-up turn, so
 * it costs a round trip and must not restart an answer that merely *mentioned* JSON.
 */
export const REMINDER =
    'Your previous reply reached the user inside a serialization envelope ({text,type}) and they could not read it. Resend it now as plain markdown text — prose, tables and fenced code only, no JSON object or array wrapping the whole message.';
