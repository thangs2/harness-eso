/**
 * Pick latest request_stop token columns for list cache (migration 007 + refresh).
 * bun:sqlite rejects ORDER BY CASE … COALESCE(request.generation_id, …) on the outer
 * request row; use prioritized COALESCE subqueries instead (WHERE refs are fine).
 */

/** @param {'input_tokens' | 'output_tokens'} column */
export function requestStopListTokenExpr(column) {
    const nullRank = `CASE WHEN rs.${column} IS NULL THEN 1 ELSE 0 END`;
    return `COALESCE(
    (SELECT rs.${column} FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NOT NULL
       AND rs.generation_id = request.generation_id
     ORDER BY ${nullRank}, rs.hook_at DESC LIMIT 1),
    (SELECT rs.${column} FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND rs.request_id = request.id
     ORDER BY ${nullRank}, rs.hook_at DESC LIMIT 1),
    (SELECT rs.${column} FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NULL
       AND rs.generation_id = request.id
     ORDER BY ${nullRank}, rs.hook_at DESC LIMIT 1)
)`;
}
