-- Denormalized fields for fast GET /api/requests (avoid correlated subqueries per row).

ALTER TABLE request ADD COLUMN list_emit_chars_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN list_decision_verdict TEXT;
ALTER TABLE request ADD COLUMN list_stop_input_tokens INTEGER;
ALTER TABLE request ADD COLUMN list_stop_output_tokens INTEGER;

CREATE INDEX IF NOT EXISTS idx_decision_ledger_turn
    ON decision_ledger(project_id, request_id, event_type, created_at DESC);

UPDATE request SET list_emit_chars_sum = (
    SELECT COALESCE(SUM(lc.emit_chars), 0) FROM llm_call lc WHERE lc.request_id = request.id
);

UPDATE request SET list_decision_verdict = (
    SELECT dl.enforced_verdict FROM decision_ledger dl
    WHERE dl.project_id = request.project_id AND dl.request_id = request.id AND dl.event_type = 'turn_start'
    ORDER BY dl.created_at DESC LIMIT 1
);

-- Stop token pick: keep in sync with request-stop-list-sql.mjs (bun:sqlite ORDER BY workaround).
UPDATE request SET list_stop_input_tokens = COALESCE(
    (SELECT rs.input_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NOT NULL
       AND rs.generation_id = request.generation_id
     ORDER BY CASE WHEN rs.input_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1),
    (SELECT rs.input_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND rs.request_id = request.id
     ORDER BY CASE WHEN rs.input_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1),
    (SELECT rs.input_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NULL
       AND rs.generation_id = request.id
     ORDER BY CASE WHEN rs.input_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1)
);

UPDATE request SET list_stop_output_tokens = COALESCE(
    (SELECT rs.output_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NOT NULL
       AND rs.generation_id = request.generation_id
     ORDER BY CASE WHEN rs.output_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1),
    (SELECT rs.output_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND rs.request_id = request.id
     ORDER BY CASE WHEN rs.output_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1),
    (SELECT rs.output_tokens FROM request_stop rs
     WHERE rs.project_id = request.project_id
       AND request.generation_id IS NULL
       AND rs.generation_id = request.id
     ORDER BY CASE WHEN rs.output_tokens IS NULL THEN 1 ELSE 0 END, rs.hook_at DESC LIMIT 1)
);
