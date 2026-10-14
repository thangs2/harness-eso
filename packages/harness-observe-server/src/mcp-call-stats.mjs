/**
 * Rebuild `mcp_call_stats` — the per-request summary the UI reads.
 *
 * Three inputs, each with a different owner, and the summary keeps them distinct on purpose:
 *
 *   - **tool calls** come from `llm_call.tool_names`, i.e. what the agent actually invoked. This is
 *     the single source for Brain / Pro / executor counts, and it only became accurate once ingest
 *     resolved Cursor's `CallDynamicTool` wrapper to the real tool.
 *   - **Brain tokens** come from `mcp_call`, the ledger the MCP server writes. Cursor's `stop` hook
 *     reports only the Dispatcher's usage, so without this a turn's DeepSeek cost was invisible.
 *   - **`jev_count` is not an MCP call at all.** Jev is invoked over HTTP by the decision facade, and
 *     this counts decision-ledger rows that carry a Jev response. It sits in the same row because the
 *     UI shows "model calls per turn" in one card; it is labelled as decisions there, not as calls.
 */
import { isoNow } from './observe-config.mjs';
import { mcpCountsFromToolNames } from './parse-transcript-calls.mjs';

/** Counters every request row starts from, so an absent call still writes explicit zeros. */
function emptyCounts() {
    return {
        flash_brain_count: 0,
        flash_executor_count: 0,
        pro_count: 0,
        smart_route_count: 0,
        jev_count: 0,
    };
}

/**
 * @param {import('./observe-db.mjs').Db} db
 * @param {string} projectId
 * @param {Set<string>|string[]|null} requestIds null = all requests in project
 */
export function refreshMcpCallStats(db, projectId, requestIds = null) {
    const ids = requestIds
        ? [...(requestIds instanceof Set ? requestIds : requestIds)]
        : db
              .all('SELECT id FROM request WHERE project_id = ?', [projectId])
              .map((r) => r.id);
    if (!ids.length) return { updated: 0 };

    const ph = ids.map(() => '?').join(',');
    const byReq = new Map();
    const accFor = (requestId) => {
        const existing = byReq.get(requestId);
        if (existing) return existing;
        const fresh = emptyCounts();
        byReq.set(requestId, fresh);
        return fresh;
    };

    for (const row of db.all(
        `SELECT c.request_id, c.tool_names FROM llm_call c
         JOIN request r ON r.id = c.request_id
         WHERE r.project_id = ? AND c.request_id IN (${ph})`,
        [projectId, ...ids],
    )) {
        const acc = accFor(row.request_id);
        const part = mcpCountsFromToolNames(row.tool_names);
        acc.flash_brain_count += part.flash_brain_count;
        acc.flash_executor_count += part.flash_executor_count;
        acc.pro_count += part.pro_count;
        acc.smart_route_count += part.smart_route_count;
        acc.jev_count += part.jev_count;
    }

    /*
     * Jev decisions, from the ledger. One decision can be recorded on both a `turn_start` and an
     * `evidence_sufficiency` row for the same request, so this counts **distinct Jev requests**, not
     * rows — counting rows doubled the number.
     *
     * A Jev call is identified by `latency_ms_jev > 0`, and deliberately NOT by
     * `jev_response_json IS NOT NULL`. That column is shared: `insertEvidenceLedger` parks the whole
     * ESO bundle in it (`JSON.stringify(bundle)`) so the ESO view can read it back, which meant every
     * `evidence_sufficiency` row counted as a Jev call. Measured on x79: 3.238 of 3.238 requests
     * reported `jev_count=1` while `jev.mode` was `off` and **no** row had `latency_ms_jev > 0` — Jev
     * had never run, and the monitor said otherwise on every request.
     *
     * Latency is the honest signal because both writers set it around a real call and leave it at 0
     * otherwise (`decide.mjs` from `jev.latencyMs`, `eso-ledger.mjs` from `row.jev_latency_ms`), and
     * `jev-l2.mjs` derives it from `Date.now()` around the HTTP round trip — so a call cannot complete
     * in 0 ms and slip through.
     */
    for (const row of db.all(
        `SELECT request_id, COUNT(DISTINCT jev_request_hash) AS n FROM decision_ledger
         WHERE project_id = ? AND request_id IN (${ph})
           AND latency_ms_jev > 0
         GROUP BY request_id`,
        [projectId, ...ids],
    )) {
        accFor(row.request_id).jev_count = Math.max(accFor(row.request_id).jev_count, row.n);
    }

    /*
     * Brain token totals. `SUM` over rows that actually reported usage; `COUNT(...)` of those rows
     * becomes `brain_usage_calls` so a partial report is visible rather than looking complete. The
     * totals stay NULL when nothing reported, because "0 tokens" and "provider did not say" are
     * different facts and the UI must be able to tell them apart.
     */
    const usageByReq = new Map();
    for (const row of db.all(
        `SELECT request_id,
                SUM(prompt_tokens)     AS prompt_tokens,
                SUM(completion_tokens) AS completion_tokens,
                SUM(cache_hit_tokens)  AS cache_hit_tokens,
                SUM(reasoning_tokens)  AS reasoning_tokens,
                COUNT(*)               AS measured
         FROM mcp_call
         WHERE project_id = ? AND request_id IN (${ph}) AND prompt_tokens IS NOT NULL
         GROUP BY request_id`,
        [projectId, ...ids],
    )) {
        usageByReq.set(row.request_id, row);
    }

    const now = isoNow();
    let updated = 0;
    for (const reqId of ids) {
        const c = byReq.get(reqId) || emptyCounts();
        const usage = usageByReq.get(reqId) || null;
        db.run(
            `INSERT INTO mcp_call_stats (
                request_id, flash_brain_count, flash_executor_count, pro_count, smart_route_count,
                jev_count, brain_prompt_tokens, brain_completion_tokens, brain_cache_hit_tokens,
                brain_reasoning_tokens, brain_usage_calls, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(request_id) DO UPDATE SET
               flash_brain_count = excluded.flash_brain_count,
               flash_executor_count = excluded.flash_executor_count,
               pro_count = excluded.pro_count,
               smart_route_count = excluded.smart_route_count,
               jev_count = excluded.jev_count,
               brain_prompt_tokens = excluded.brain_prompt_tokens,
               brain_completion_tokens = excluded.brain_completion_tokens,
               brain_cache_hit_tokens = excluded.brain_cache_hit_tokens,
               brain_reasoning_tokens = excluded.brain_reasoning_tokens,
               brain_usage_calls = excluded.brain_usage_calls,
               updated_at = excluded.updated_at`,
            [
                reqId,
                c.flash_brain_count,
                c.flash_executor_count,
                c.pro_count,
                c.smart_route_count,
                c.jev_count,
                usage ? Number(usage.prompt_tokens ?? 0) : null,
                usage ? Number(usage.completion_tokens ?? 0) : null,
                usage ? Number(usage.cache_hit_tokens ?? 0) : null,
                usage ? Number(usage.reasoning_tokens ?? 0) : null,
                usage ? Number(usage.measured ?? 0) : 0,
                now,
            ],
        );
        updated += 1;
    }
    return { updated };
}
