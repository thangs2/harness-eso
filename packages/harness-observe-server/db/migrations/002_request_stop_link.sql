-- Attribute a `stop` back to the request it belongs to.
--
-- A stop carries the turn's token totals, but the only join key it shares with
-- the request spine is `generation_id` — and that only exists when the matching
-- `beforeSubmitPrompt` was captured. Turns recorded before that hook was
-- installed have a stop with no prompt, so their tokens were stranded. The link
-- is therefore resolved in two steps (see linkRequests): exact generation first,
-- then by wall-clock turn window, which is materialised here so the UI can show
-- attribution instead of re-deriving it on every read.

ALTER TABLE request_stop ADD COLUMN request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_request_stop_request ON request_stop(project_id, request_id);
CREATE INDEX IF NOT EXISTS idx_request_stop_conv ON request_stop(project_id, conversation_id, hook_at);
