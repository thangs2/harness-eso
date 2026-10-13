/**
 * Antigravity turns often exist on the transcript spine before hook trace links.
 * Project tool/file/event evidence and UI fallbacks from llm_call rows.
 */

/** @param {import('./db.mjs').Db} db */
export function backfillAntigravityGenerationIds(db, projectId) {
    db.run(
        `UPDATE request SET generation_id = id
         WHERE project_id = ? AND (generation_id IS NULL OR generation_id = '')
           AND id GLOB '*:*'`,
        [projectId],
    );
}

/** @param {import('./db.mjs').Db} db */
export function linkEventsByGenerationOrRequestId(db, projectId) {
    db.run(
        `UPDATE event SET request_id = (
            SELECT r.id FROM request r
             WHERE r.project_id = event.project_id
               AND (r.generation_id = event.generation_id OR r.id = event.generation_id)
             LIMIT 1)
         WHERE project_id = ? AND request_id IS NULL AND generation_id IS NOT NULL`,
        [projectId],
    );
}

/** @param {import('./db.mjs').Db} db */
export function rollRequestToolsFromLlmCalls(db, requestId) {
    const rows = db.all(
        `SELECT tool_names FROM llm_call
         WHERE request_id = ? AND tool_names IS NOT NULL AND trim(tool_names) != ''`,
        [requestId],
    );
    const counts = new Map();
    for (const row of rows) {
        for (const t of String(row.tool_names)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)) {
            counts.set(t, (counts.get(t) || 0) + 1);
        }
    }
    if (!counts.size) return false;
    for (const [tool, count] of counts) {
        db.run(
            `INSERT INTO request_tool (request_id, tool, count) VALUES (?, ?, ?)
             ON CONFLICT(request_id, tool) DO UPDATE SET count = excluded.count`,
            [requestId, tool, count],
        );
    }
    return true;
}

/**
 * UI / API fallback when hook postToolUse rows are missing (AG trace not wired yet).
 * @param {object[]} llmCalls
 */
const PREVIEW_PATH_RE =
    /(?:^|[\s"'`(])(@?(?:[\w@.-]+\/)+[\w@./-]+\.(?:mdc?|tsx?|jsx?|mjs|cjs|json|sql|yml|yaml)|@?[\w][\w.-]*\.(?:mdc|md))(?:[\s"'`),]|$)/gi;

function pathsFromPreview(preview) {
    const out = [];
    const seen = new Set();
    for (const m of String(preview || '').matchAll(PREVIEW_PATH_RE)) {
        const p = m[1].replace(/^@/, '');
        if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

export function synthesizePostToolEventsFromLlmCalls(llmCalls, rootPath) {
    const root = String(rootPath || '').replace(/\\/g, '/');
    const rel = (p) => {
        let s = String(p || '').replace(/\\/g, '/');
        if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
        return s;
    };
    const out = [];
    for (const c of llmCalls || []) {
        const paths = pathsFromPreview(c.preview).map(rel);
        const tools = String(c.toolNames || '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (!tools.length) continue;
        tools.forEach((tool, ti) => {
            out.push({
                harness: 'agents',
                eventType: 'postToolUse',
                tool,
                path: paths[ti] ?? paths[0] ?? null,
                hookAt: null,
                command: null,
                synthetic: true,
            });
        });
    }
    return out;
}

/**
 * @param {object} request row
 * @param {object[]} llmCalls
 * @param {object[]} stops
 */
/** @param {object[]} llmCalls */
export function toolsSummaryFromLlmCalls(llmCalls) {
    const counts = new Map();
    for (const c of llmCalls || []) {
        for (const t of String(c.toolNames || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)) {
            counts.set(t, (counts.get(t) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count);
}

export function tokenSummaryForRequest(request, llmCalls, stops) {
    const stop = (stops || []).find((s) => s.inputTokens != null || s.outputTokens != null);
    if (request.input_tokens != null || request.output_tokens != null) {
        return {
            input: request.input_tokens,
            output: request.output_tokens,
            cacheRead: request.cache_read_tokens,
            source: 'request',
        };
    }
    if (stop) {
        return {
            input: stop.inputTokens,
            output: stop.outputTokens,
            cacheRead: stop.cacheRead,
            source: `stop (${stop.harness || 'hook'})`,
        };
    }
    const est = (llmCalls || []).reduce((a, c) => a + (Number(c.estTokens) || 0), 0);
    if (est > 0) {
        const textChars = Number(request.text_chars);
        const outputEst = Number.isFinite(textChars) && textChars > 0
            ? Math.round(textChars / 4)
            : est;
        return {
            // Input tokens are NOT derivable from a transcript. The model's input is the whole
            // context — system prompt + attached rules + open files + history + tool results —
            // and only a hook `stop` payload reports it. The previous fallback reported the
            // user's own prompt length ÷4 as "input", which rendered as a real measurement:
            // 9 next to 628 out, i.e. orders of magnitude too small and actively misleading.
            // Reporting null lets the UI say "—" (unknown) instead of inventing a number.
            input: null,
            output: outputEst,
            cacheRead: null,
            source: 'transcript-est',
            estimated: true,
            outputEstimated: true,
            inputUnavailable: 'no_token_usage_in_transcript',
        };
    }
    return { input: null, output: null, cacheRead: null, source: 'none' };
}
