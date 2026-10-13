/**
 * Time-bucket chart data — `GET /api/aggregates` (15.observe-api-contract.md §5.6).
 */

/**
 * @param {import('./observe-db.mjs').Db} db
 * @param {{ project: { id: string } }} cfg
 * @param {URL} url
 */
export function aggregates(db, cfg, url) {
    const p = url.searchParams;
    const grain = (p.get('bucket') || 'hour') === 'day' ? 10 : 13;
    const buckets = db.all(
        `SELECT substr(COALESCE(started_at, created_at), 1, ?) AS t,
                COUNT(*) AS requests,
                COALESCE(SUM(call_count), 0) AS llmCalls,
                COALESCE(SUM(tool_count), 0) AS tools,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(has_failures), 0) AS failures
         FROM request WHERE project_id = ?
         GROUP BY t ORDER BY t`,
        [grain, cfg.project.id],
    );
    return { buckets };
}
