-- MCP call fidelity: count the calls the agent actually made, and carry the tokens the
-- model provider actually reported.
--
-- Two separate gaps made the token story wrong on Cursor:
--
--   1. Every MCP call arrives as one generic tool (`CallDynamicTool`) with the real server and
--      tool in the input. `llm_call.tool_names` stored the wrapper name, so `mcp_call_stats`
--      reported zero Brain and Pro calls for every turn — 339 Brain calls in one conversation,
--      all counted as `CallDynamicTool`. Re-ingest now stores the resolved tool
--      (`mcp:ask_deepseek_flash_brain`), which the classifier can read.
--
--   2. Nothing recorded the tokens spent inside an MCP call. Cursor's `stop` hook reports the
--      Dispatcher's own usage (Composer), and the transcript carries no usage at all, so a turn
--      that spent most of its cost in DeepSeek looked cheap. The `mcp_call` table holds what the
--      MCP server reports — joined by prompt hash, because that is the only identifier both sides
--      share.
--
-- `smart_route_count` is separate rather than folded into `pro_count`/`flash_executor_count`:
-- the smart router picks its tier from complexity keywords at call time, and re-deriving that
-- here would be a second source of truth for routing.

ALTER TABLE mcp_call_stats ADD COLUMN smart_route_count INTEGER NOT NULL DEFAULT 0;

-- Brain token totals, summed from `mcp_call`. NULL (not 0) when no call reported usage, so the
-- UI can distinguish "no tokens were spent" from "the provider did not tell us".
ALTER TABLE mcp_call_stats ADD COLUMN brain_prompt_tokens INTEGER;
ALTER TABLE mcp_call_stats ADD COLUMN brain_completion_tokens INTEGER;
ALTER TABLE mcp_call_stats ADD COLUMN brain_cache_hit_tokens INTEGER;
ALTER TABLE mcp_call_stats ADD COLUMN brain_reasoning_tokens INTEGER;
-- How many calls contributed those totals, so partial reporting is visible.
ALTER TABLE mcp_call_stats ADD COLUMN brain_usage_calls INTEGER NOT NULL DEFAULT 0;

-- One row per model call made through an MCP server.
CREATE TABLE IF NOT EXISTS mcp_call (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    request_id          TEXT,
    conversation_id     TEXT,
    -- Resolved role label, same vocabulary as `llm_call.tool_names`
    -- (`mcp:ask_deepseek_flash_brain`, …).
    tool                TEXT NOT NULL,
    model               TEXT,
    -- sha256 of the prompt as sent to the model. The transcript records the same prompt, so this
    -- is the join key between "what the agent asked" and "what the provider charged".
    prompt_sha256       TEXT,
    prompt_chars        INTEGER,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    cache_hit_tokens    INTEGER,
    cache_miss_tokens   INTEGER,
    reasoning_tokens    INTEGER,
    elapsed_ms          INTEGER,
    aborted             INTEGER NOT NULL DEFAULT 0,
    http_status         INTEGER,
    at                  TEXT NOT NULL,
    -- Which ledger the row came from, so a second reporter can be added without losing provenance.
    source              TEXT NOT NULL DEFAULT 'deepseek-ledger'
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_request ON mcp_call (request_id);
CREATE INDEX IF NOT EXISTS idx_mcp_call_prompt ON mcp_call (prompt_sha256);

-- Every model prompt the agent sent through an MCP server, tied to the turn that sent it.
--
-- This is the other half of the join. The MCP server cannot name the Cursor conversation it is
-- serving — it receives a prompt and nothing else — so it records `sha256(prompt)`, and this table
-- says which request that prompt belonged to. Together they attribute spend without either side
-- guessing from timestamps, which would misattribute whenever two turns overlap.
CREATE TABLE IF NOT EXISTS mcp_prompt (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    request_id      TEXT NOT NULL,
    llm_call_id     TEXT,
    -- Resolved role label, matching `llm_call.tool_names`.
    tool            TEXT NOT NULL,
    prompt_sha256   TEXT NOT NULL,
    prompt_chars    INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_prompt_sha ON mcp_prompt (prompt_sha256);
CREATE INDEX IF NOT EXISTS idx_mcp_prompt_request ON mcp_prompt (request_id);

-- Records how far each conversation has been walked, for the MCP attribution backfill.
--
-- Live ingest only reads new bytes, so calls made before this feature existed were stored with the
-- generic wrapper name and their prompts were never recorded — leaving both the counts and the
-- spend permanently wrong for everything already on disk. This marks the conversations already
-- walked.
--
-- `step_version` exists because the walk does more than one thing, and a conversation walked by an
-- older step must be walked again by a newer one. Without it, adding a step would silently apply
-- only to conversations ingested after the change.
CREATE TABLE IF NOT EXISTS mcp_prompt_backfill (
    conversation_id TEXT PRIMARY KEY,
    byte_size       INTEGER NOT NULL DEFAULT 0,
    step_version    INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL
);
