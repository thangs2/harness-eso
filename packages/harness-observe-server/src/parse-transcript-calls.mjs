/**
 * Pure, from-byte-0 walker over a transcript buffer.
 *
 * It exists so the emit_chars backfill cannot drift from ingest: it imports the
 * SAME assistantStats (which owns the emitChars formula) and the SAME
 * classifyUserLine (which owns the boundary rules) that ingest-transcript.mjs
 * uses. No db, no fs cursor, no module state — the same file always yields the
 * same rows.
 *
 * One assistant line = one call; a boundary is a real `<user_query>` line, with
 * Cursor's consecutive prompt repeats collapsed. The returned
 * `${boundaryIndex}:${callIndex}` therefore matches the deterministic llm_call.id
 * ingest writes for that file.
 */

import { assistantStats, classifyUserLine } from './ingest-transcript.mjs';

/**
 * Classify a tool label from transcript / llm_call.tool_names (WP8).
 *
 * Order matters. `ask_deepseek_flash_brain` and `ask_deepseek_flash_brain_fallback` are Brain tiers
 * but both contain `ask_deepseek_flash`, so they are checked before it.
 *
 * The label vocabulary comes from `mcpToolLabel` (which reads Cursor's `CallDynamicTool` input) and
 * matches the consumer's own `BRAIN_VIA` set. A bare `ask_deepseek_flash` is the **executor** — the
 * Brain tiers of that tool carry a prompt prefix which `mcpToolLabel` resolves — and this used to be
 * classified as Brain, so every executor call was counted as a paid reasoning call.
 *
 * `ask_deepseek_auto` is the smart router whose tier the server derives from complexity keywords at
 * call time. It is reported as its own bucket rather than guessed into Pro or Flash: re-implementing
 * that heuristic here would make a second source of truth for routing.
 *
 * @returns {'pro'|'flash_brain'|'flash_executor'|'smart'|'jev'|null}
 */
export function classifyMcpToolName(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    if (n.includes('ask_deepseek_flash_brain')) return 'flash_brain';
    if (n.includes('ask_deepseek_pro')) return 'pro';
    if (n.includes('ask_deepseek_auto')) return 'smart';
    if (n.includes('jev') || n.includes('typesafe') || n.includes('system_one')) return 'jev';
    // A bare `ask_deepseek_flash` is the executor; the Brain tiers were matched above.
    if (n.includes('ask_deepseek_flash')) return 'flash_executor';
    if (n.includes('ask_deepseek')) return 'flash_executor';
    return null;
}

/** @param {string} toolNamesCsv comma-separated tool_use names */
export function mcpCountsFromToolNames(toolNamesCsv) {
    const out = {
        flash_brain_count: 0,
        flash_executor_count: 0,
        pro_count: 0,
        smart_route_count: 0,
        jev_count: 0,
    };
    for (const raw of String(toolNamesCsv || '').split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const kind = classifyMcpToolName(name);
        if (kind === 'pro') out.pro_count += 1;
        else if (kind === 'flash_brain') out.flash_brain_count += 1;
        else if (kind === 'flash_executor') out.flash_executor_count += 1;
        else if (kind === 'smart') out.smart_route_count += 1;
        else if (kind === 'jev') out.jev_count += 1;
    }
    return out;
}

/**
 * @param {Buffer|string} content full transcript contents, from byte 0
 * @returns {Array<{
 *   boundaryIndex: number,
 *   callIndex: number,
 *   lineNo: number,
 *   tools: number,
 *   textChars: number,
 *   emitChars: number,
 *   toolNames: string,
 *   preview: string,
 * }>}
 */
export function parseTranscriptCalls(content) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    const parts = text.split('\n');
    const completeCount = text.endsWith('\n') ? parts.length - 1 : Math.max(0, parts.length - 1);

    const out = [];
    let boundaryIndex = 0;
    let lastBoundaryKey = null;
    let callIndex = 0;

    for (let i = 0; i < completeCount; i += 1) {
        const line = parts[i];
        if (!line.trim()) continue;

        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue; // a half-flushed line is not fatal
        }

        if (rec.type === 'turn_ended') continue;

        if (rec.role === 'user') {
            const b = classifyUserLine(rec.message, lastBoundaryKey);
            if (b.kind !== 'boundary') continue;
            lastBoundaryKey = b.key;
            boundaryIndex += 1;
            callIndex = 0;
            continue;
        }

        if (rec.role === 'assistant') {
            if (!boundaryIndex) continue; // pre-prompt context; nothing to attribute it to
            const st = assistantStats(rec.message);
            callIndex += 1;
            const mcp = mcpCountsFromToolNames(st.names.join(','));
            out.push({
                boundaryIndex,
                callIndex,
                lineNo: i + 1,
                tools: st.tools,
                textChars: st.textChars,
                emitChars: st.emitChars,
                toolNames: st.names.join(','),
                preview: st.preview,
                mcp,
                /** Model prompts sent through MCP, for attributing provider-reported usage. */
                mcpPrompts: st.mcpPrompts,
            });
        }
    }

    return out;
}
