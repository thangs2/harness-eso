import assert from 'node:assert/strict';
import test from 'node:test';

import { detectWrappedOutput, unwrapWrappedOutput } from '../.cursor/hooks/detect-json-wrapper.mjs';

/**
 * The assistant's response sometimes arrives wrapped in a serialization envelope instead of plain
 * text: a `{ text, type }` object, or an array of them, sometimes nested more than once. The user
 * reads the envelope as noise and cannot read the answer through it.
 *
 * These tests pin the shape against the real samples the user pasted, and — just as important — pin
 * the *negatives*. A detector that fires on ordinary markdown containing a JSON code block would be
 * worse than the bug: it would inject "you were wrapped" feedback into every correct answer.
 */

const REAL_SINGLE = `{"text": "Có mẫu thật rồi. Tôi phân tích chính xác nó bị gì.", "type": "text"}`;

// The exact shape observed: an inner array wrapped in a text field, then wrapped again.
const REAL_DOUBLE = `{"text": "[{\\"text\\": \\"baplatform went amber — it was ✔ ten minutes ago.\\", \\"type\\": \\"text\\"}]\\n", "type": "text"}`;

// A third nesting, as seen in the transcript.
const REAL_TRIPLE = `{"text": "[{\\"text\\": \\"[{\\\\\\"text\\\\\\": \\\\\\"Kiểm tra\\\\\\", \\\\\\"type\\\\\\": \\\\\\"text\\\\\\"}]\\", \\"type\\": \\"text\\"}]", "type": "text"}`;

test('detects the real single-layer envelope', () => {
    assert.equal(detectWrappedOutput(REAL_SINGLE), true);
});

test('detects the real double-layer envelope', () => {
    assert.equal(detectWrappedOutput(REAL_DOUBLE), true);
});

test('detects the real triple-layer envelope', () => {
    assert.equal(detectWrappedOutput(REAL_TRIPLE), true);
});

test('detects a bare array of text parts', () => {
    assert.equal(detectWrappedOutput(`[{"text":"hello","type":"text"}]`), true);
});

test('does not fire on ordinary markdown', () => {
    const md = [
        '## Heading',
        '',
        'Some prose with `code` and a table:',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
    ].join('\n');
    assert.equal(detectWrappedOutput(md), false);
});

test('does not fire on prose that merely starts with a brace', () => {
    assert.equal(detectWrappedOutput('{this is not json} and neither is this'), false);
});

test('does not fire on a fenced JSON block inside an answer', () => {
    const md = ['Here is the payload the API returns:', '', '```json', REAL_SINGLE, '```'].join('\n');
    // The fenced block is legitimate: it is showing JSON, not wrapped by it. Detection is about the
    // whole response being an envelope, so anything before the fence means it is not.
    assert.equal(detectWrappedOutput(md), false);
});

test('does not fire on a JSON object with other keys', () => {
    assert.equal(detectWrappedOutput('{"ok":true,"items":[1,2,3]}'), false);
});

test('does not fire on an empty or whitespace response', () => {
    assert.equal(detectWrappedOutput(''), false);
    assert.equal(detectWrappedOutput('   \n\t '), false);
});

test('unwraps nested envelopes down to plain text', () => {
    assert.equal(unwrapWrappedOutput(REAL_SINGLE), 'Có mẫu thật rồi. Tôi phân tích chính xác nó bị gì.');
    assert.equal(
        unwrapWrappedOutput(REAL_DOUBLE).trim(),
        'baplatform went amber — it was ✔ ten minutes ago.',
    );
});

test('leaves plain markdown untouched when unwrapping', () => {
    const md = '## Heading\n\nplain text';
    assert.equal(unwrapWrappedOutput(md), md);
});

test('unwrapping is idempotent and cannot loop forever', () => {
    // A malformed input must terminate, not recurse on its own output.
    const once = unwrapWrappedOutput(REAL_TRIPLE);
    assert.equal(typeof once, 'string');
    assert.equal(unwrapWrappedOutput(once), once);
});
