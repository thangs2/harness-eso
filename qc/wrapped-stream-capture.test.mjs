import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnoseStream } from '../scripts/capture/diagnose-wrapped-stream.mjs';

/**
 * The capture path exists to settle one question: did the envelope arrive from the provider, or did
 * something between the provider and the transcript invent it? Its verdict must be decided by the
 * *first* text frame — anything later can be manipulated by a client-side pass, the opening delta
 * cannot.
 */

const frame = (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

test('a stream whose first delta already opens the envelope is the model', () => {
    const raw = frame('[{"text": "Hel') + frame('lo", "type": "text"}]') + 'data: [DONE]\n';
    const report = diagnoseStream(raw);
    assert.equal(report.wrapped, true);
    assert.equal(report.envelopeAtStart, true);
});

test('a clean stream is attributed downstream, not to the provider', () => {
    const report = diagnoseStream(frame('Hello') + frame(', world'));
    assert.equal(report.wrapped, false);
    assert.equal(report.envelopeAtStart, false);
    assert.equal(report.text, 'Hello, world');
});

test('reads Anthropic and OpenAI Responses frames too, and ignores non-SSE noise', () => {
    const anthropic = [
        'HTTP/1.1 200 OK',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"## Done"}}',
        'event: ping',
        'data: {"type":"message_stop"}',
    ].join('\n');
    assert.equal(diagnoseStream(anthropic).text, '## Done');

    const responses = 'data: {"type":"response.output_text.delta","delta":"hi"}';
    assert.equal(diagnoseStream(responses).text, 'hi');
});

test('a truncated or non-JSON frame contributes no text and does not throw', () => {
    const report = diagnoseStream('data: {"choices": [\n\ndata: not json\n\n');
    assert.equal(report.text, '');
    assert.equal(report.wrapped, false);
});
