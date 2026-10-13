/**
 * Rebuild mcp_call_stats from llm_call.tool_names + decision_ledger Jev rows.
 */
import { isoNow } from './observe-config.mjs';
import { mcpCountsFromToolNames } from './parse-transcript-calls.mjs';

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
    const calls = db.all(
        `SELECT c.request_id, c.tool_names FROM llm_call c
         JOIN request r ON r.id = c.request_id
         WHERE r.project_id = ? AND c.request_id IN (${ph})`,
        [projectId, ...ids],
    );
    const byReq = new Map();
    for (const row of calls) {
        const acc = byReq.get(row.request_id) || {
            flash_brain_count: 0,
            flash_executor_count: 0,
            pro_count: 0,
            jev_count: 0,
        };
        const part = mcpCountsFromToolNames(row.tool_names);
        acc.flash_brain_count += part.flash_brain_count;
        acc.flash_executor_count += part.flash_executor_count;
        acc.pro_count += part.pro_count;
        acc.jev_count += part.jev_count;
        byReq.set(row.request_id, acc);
    }

    const jevRows = db.all(
        `SELECT request_id, COUNT(*) AS n FROM decision_ledger
         WHERE project_id = ? AND request_id IN (${ph})
           AND jev_response_json IS NOT NULL AND jev_response_json != ''
         GROUP BY request_id`,
        [projectId, ...ids],
    );
    for (const row of jevRows) {
        const acc = byReq.get(row.request_id) || {
            flash_brain_count: 0,
            flash_executor_count: 0,
            pro_count: 0,
            jev_count: 0,
        };
        acc.jev_count = Math.max(acc.jev_count, row.n);
        byReq.set(row.request_id, acc);
    }

    const now = isoNow();
    let updated = 0;
    for (const reqId of ids) {
        const c = byReq.get(reqId) || {
            flash_brain_count: 0,
            flash_executor_count: 0,
            pro_count: 0,
            jev_count: 0,
        };
        db.run(
            `INSERT INTO mcp_call_stats (request_id, flash_brain_count, flash_executor_count, pro_count, jev_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(request_id) DO UPDATE SET
               flash_brain_count = excluded.flash_brain_count,
               flash_executor_count = excluded.flash_executor_count,
               pro_count = excluded.pro_count,
               jev_count = excluded.jev_count,
               updated_at = excluded.updated_at`,
            [
                reqId,
                c.flash_brain_count,
                c.flash_executor_count,
                c.pro_count,
                c.jev_count,
                now,
            ],
        );
        updated += 1;
    }
    return { updated };
}
