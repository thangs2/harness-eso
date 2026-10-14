/**
 * Maintain denormalized list columns on `request` (see migration 007).
 */

import { requestStopListTokenExpr } from './request-stop-list-sql.mjs';

const STOP_INPUT_SQL = requestStopListTokenExpr('input_tokens');
const STOP_OUTPUT_SQL = requestStopListTokenExpr('output_tokens');

/**
 * @param {import('@mu/harness-foundation').SqliteDb} db
 * @param {string} projectId
 * @param {{ requestIds?: Set<string> | null, all?: boolean }} scope
 */
export function refreshRequestListCache(db, projectId, scope = {}) {
    const ids = scope.requestIds;
    const refreshAll = scope.all === true || ids === null;
    if (!refreshAll && (!ids || ids.size === 0)) return 0;

    const where = refreshAll
        ? 'project_id = ?'
        : `project_id = ? AND id IN (${[...ids].map(() => '?').join(',')})`;
    const params = refreshAll ? [projectId] : [projectId, ...ids];

    db.run(
        `UPDATE request SET
            list_emit_chars_sum = (
                SELECT COALESCE(SUM(lc.emit_chars), 0) FROM llm_call lc WHERE lc.request_id = request.id
            ),
            list_decision_verdict = COALESCE(
                (
                    SELECT dl.enforced_verdict FROM decision_ledger dl
                    WHERE dl.project_id = request.project_id AND dl.request_id = request.id
                      AND dl.event_type = 'turn_start'
                    ORDER BY dl.created_at DESC LIMIT 1
                ),
                (
                    SELECT dl.enforced_verdict FROM decision_ledger dl
                    WHERE dl.project_id = request.project_id AND dl.request_id = request.id
                      AND dl.event_type = 'evidence_sufficiency'
                    ORDER BY dl.created_at DESC LIMIT 1
                )
            ),
            list_stop_input_tokens = ${STOP_INPUT_SQL},
            list_stop_output_tokens = ${STOP_OUTPUT_SQL}
         WHERE ${where}`,
        params,
    );

    return refreshAll ? db.get('SELECT changes() AS n').n : ids.size;
}
