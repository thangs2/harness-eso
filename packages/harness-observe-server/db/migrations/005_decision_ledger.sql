-- 005_decision_ledger.sql — Decision Facade ledger (design doc §10)
-- Maps SESSION/TURN concepts to harness conversation + request ids.

CREATE TABLE IF NOT EXISTS decision_ledger (
    id                      TEXT PRIMARY KEY,
    project_id              TEXT REFERENCES project(id) ON DELETE CASCADE,
    conversation_id         TEXT,
    request_id              TEXT,
    event_type              TEXT NOT NULL,
    jev_mode                TEXT NOT NULL,
    resolver_winner         TEXT,
    l0_candidates_json      TEXT,
    jev_request_hash        TEXT,
    jev_response_json       TEXT,
    top_probability         REAL,
    enforced_verdict        TEXT NOT NULL,
    ambiguous_policy        TEXT,
    latency_ms_l0           INTEGER NOT NULL DEFAULT 0,
    latency_ms_jev          INTEGER NOT NULL DEFAULT 0,
    flash_fallback_used     INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_ledger_request
    ON decision_ledger(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_ledger_conversation
    ON decision_ledger(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_ledger_hash
    ON decision_ledger(jev_request_hash);

CREATE TABLE IF NOT EXISTS mcp_call_stats (
    request_id              TEXT PRIMARY KEY,
    flash_brain_count       INTEGER NOT NULL DEFAULT 0,
    flash_executor_count    INTEGER NOT NULL DEFAULT 0,
    pro_count               INTEGER NOT NULL DEFAULT 0,
    jev_count               INTEGER NOT NULL DEFAULT 0,
    updated_at              TEXT NOT NULL
);
