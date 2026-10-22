/**
 * Read a captured provider SSE stream and say, for each assistant text delta, whether it *arrived*
 * wrapped or whether the envelope appeared later.
 *
 * This is the measurement the reply structure could not give. The 74 observed envelopes all sit at
 * text-block index 0 with an extra outer `{text,type}` — strong evidence the model wrote them, but
 * still inference. A captured stream settles it: if the first content delta carrying text already
 * begins `[{"text":`, the model emitted the envelope into the text channel and nothing downstream
 * invented it. If the deltas are clean prose and only the stored message is wrapped, the host's
 * sanitizer is the author.
 *
 * Input is whatever `mitmproxy` wrote — a raw HTTP response body, or the `response.body` a
 * mitmproxy addon dumped. Both are handled: the SSE frame parser ignores everything that is not a
 * `data:` line, so an HTTP header block in front of the stream is harmless.
 *
 * Usage:
 *   node scripts/capture/diagnose-wrapped-stream.mjs capture.sse
 *   cat capture.sse | node scripts/capture/diagnose-wrapped-stream.mjs --json
 */
import fs from 'node:fs';

import { inspectAgentText } from '../../.cursor/hooks/lib/agent-response.mjs';

/** Every string this frame contributes to the assistant text, whichever wire format the provider used. */
function textOfFrame(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const out = [];

    // Anthropic Messages: {type:'content_block_delta', delta:{type:'text_delta', text}}
    if (payload.delta && typeof payload.delta.text === 'string') out.push(payload.delta.text);
    // OpenAI Responses: {type:'response.output_text.delta', delta:'...'}
    else if (typeof payload.delta === 'string') out.push(payload.delta);
    // OpenAI Chat Completions: {choices:[{delta:{content}}]}
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
        if (typeof choice?.delta?.content === 'string') out.push(choice.delta.content);
        if (typeof choice?.text === 'string') out.push(choice.text);
    }
    // Anthropic non-streaming body: content: [{type:'text', text}]
    if (Array.isArray(payload.content)) {
        for (const block of payload.content) {
            if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
        }
    }
    return out.filter((s) => s.length > 0);
}

/**
 * @param {string} raw captured stream
 * @returns {{ frames: number, textFrames: number, text: string, wrapped: boolean, firstTextFrame: string, envelopeAtStart: boolean }}
 */
export function diagnoseStream(raw) {
    const frames = [];
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
            frames.push(JSON.parse(data));
        } catch {
            /* a partial or non-JSON frame contributes no text */
        }
    }
    const texts = frames.flatMap(textOfFrame);
    const text = texts.join('');
    const first = texts[0] ?? '';
    const { wrapped } = inspectAgentText(text);
    return {
        frames: frames.length,
        textFrames: texts.length,
        text,
        wrapped,
        firstTextFrame: first.slice(0, 200),
        // Decided by the *first* delta: a stream whose opening text already is an envelope cannot be
        // explained by anything that runs after the model. Streams are split mid-token, so the test is
        // on the opening prefix — the first frame often carries only `[{"text": "` and half a sentence.
        envelopeAtStart: /^\s*\[\s*\{\s*"text"\s*:/.test(first),
    };
}

function main(argv) {
    const file = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
    const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
    const report = diagnoseStream(raw);

    if (argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify({ ...report, text: report.text.slice(0, 2000) }, null, 2)}\n`);
        return;
    }
    const verdict = report.envelopeAtStart
        ? 'MODEL — the envelope is already in the first text delta'
        : report.wrapped
          ? 'AMBIGUOUS — the delta is clean but the assembled text is an envelope; look for injection between deltas'
          : 'HOST — the stream carries clean prose; any stored envelope appeared downstream';
    process.stdout.write(
        [
            `frames: ${report.frames} (${report.textFrames} carrying text)`,
            `first text delta: ${JSON.stringify(report.firstTextFrame)}`,
            `assembled text is an envelope: ${report.wrapped}`,
            `verdict: ${verdict}`,
            '',
        ].join('\n'),
    );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main(process.argv);
}
