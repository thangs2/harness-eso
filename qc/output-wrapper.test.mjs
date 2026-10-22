import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditWrappedReplies } from '../.cursor/hooks/audit-wrapped-replies.mjs';

import {
    detectWrappedOutput,
    extractResponseText,
    inspectAgentText,
    unwrapWrappedOutput,
} from '../.cursor/hooks/lib/agent-response.mjs';
import { stopVerdict } from '../.cursor/hooks/wrapped-output-guard.mjs';

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

/**
 * The host's `afterAgentResponse` input is `{ text }` and it has already unescaped once. So a wrapped
 * reply reaches the hook as a *stringified* array sitting inside `text` — a shape the first version of
 * this detector missed, which is why the guard never fired on the live host.
 */
test('detects the envelope as the host delivers it, already unescaped once', () => {
    const hostText = JSON.stringify([{ text: 'baplatform went amber', type: 'text' }]);
    assert.equal(hostText, '[{"text":"baplatform went amber","type":"text"}]');
    assert.equal(inspectAgentText(hostText).wrapped, true);
    assert.equal(inspectAgentText(hostText).peeled, 'baplatform went amber');
    assert.equal(inspectAgentText(JSON.stringify({ text: hostText })).wrapped, true);
});

test('reads the response out of the flat `{ text }` payload Cursor actually sends', () => {
    assert.equal(extractResponseText({ text: 'hello' }), 'hello');
    assert.equal(extractResponseText('plain string'), 'plain string');
    assert.equal(extractResponseText({}), '');
    assert.equal(extractResponseText(null), '');
});

test('does not accuse a reply that mentions the envelope shape but is not one', () => {
    const prose = 'The host sends {"text": "...", "type": "text"} and we unwrap it.';
    assert.equal(inspectAgentText(prose).wrapped, false);
    const fenced = ['Here is the shape:', '', '```json', REAL_SINGLE, '```'].join('\n');
    assert.equal(inspectAgentText(fenced).wrapped, false);
});

test('stop hook asks for a resend once, and stops after a second failed attempt', () => {
    const wrapped = { status: 'completed', text: JSON.stringify([{ text: 'hi', type: 'text' }]) };
    assert.match(stopVerdict({ ...wrapped, loop_count: 0 }).followup_message, /plain markdown/);
    // Second consecutive wrap: the reminder is not landing, so do not spin.
    assert.deepEqual(stopVerdict({ ...wrapped, loop_count: 1 }), {});
});

test('stop hook stays silent on a clean reply, an aborted turn, or unreadable input', () => {
    assert.deepEqual(stopVerdict({ status: 'completed', loop_count: 0, text: '## Done\n\nAll good.' }), {});
    assert.deepEqual(stopVerdict({ status: 'aborted', loop_count: 0, text: REAL_SINGLE }), {});
    assert.deepEqual(stopVerdict({ status: 'completed', loop_count: 0 }), {});
});

/** A transcript line as the host writes it: `role: assistant`, text blocks inside `message.content`. */
function transcriptLine(role, blocks) {
    return JSON.stringify({ role, message: { content: blocks } });
}

test('audit counts turns and wraps from real transcript lines, and ignores tool blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-audit-'));
    try {
        const project = path.join(dir, 'projects', 'demo', 'agent-transcripts', 'abc');
        fs.mkdirSync(project, { recursive: true });
        const lines = [
            transcriptLine('user', [{ type: 'text', text: 'hi' }]),
            transcriptLine('assistant', [{ type: 'text', text: 'clean answer' }]),
            transcriptLine('assistant', [{ type: 'tool_use', name: 'Shell', input: {} }]),
            transcriptLine('assistant', [{ type: 'text', text: '[{"text":"wrapped","type":"text"}]' }]),
            'not json at all',
        ];
        fs.writeFileSync(path.join(project, 'abc.jsonl'), lines.join('\n'));

        const report = auditWrappedReplies({ root: path.join(dir, 'projects'), days: 3650, samples: 1 });
        assert.equal(report.turns, 2);
        assert.equal(report.wrapped, 1);
        assert.equal(report.rate, 0.5);
        assert.deepEqual(report.byProject.demo, { turns: 2, wrapped: 1 });
        assert.equal(report.samples.length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('audit is silent on a missing root rather than throwing', () => {
    const report = auditWrappedReplies({ root: path.join(os.tmpdir(), 'definitely-not-here-000') });
    assert.deepEqual(report, { turns: 0, wrapped: 0, rate: 0, byProject: {}, samples: [] });
});
