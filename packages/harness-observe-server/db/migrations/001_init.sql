-- 001_init.sql — harness monitor schema (v1)
--
-- Two sources feed this DB, and each row says which one is authoritative:
--   transcript  = the agent conversation file under ~/.cursor/projects/**
--                 it owns the REQUEST spine and the LLM-call step boundaries
--   hooks       = .cursor/session/route-trace.jsonl + .agents/session/...
--                 they own routing evidence, attached rules, and token totals
--
-- Every table that can be re-ingested carries a UNIQUE key, so ingest is
-- idempotent: running it twice must leave the counts unchanged.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- project. One DB belongs to exactly one project: the config at the repo root
-- decides which. A future dashboard reads this row over HTTP rather than
-- opening another project's database file.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
    id             TEXT PRIMARY KEY,
    display_name   TEXT,
    root_path      TEXT NOT NULL,
    config_path    TEXT NOT NULL,
    storage_driver TEXT NOT NULL DEFAULT 'sqlite',
    storage_target TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- conversation = one agent chat thread = one transcript file
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    transcript_path TEXT,
    byte_size       INTEGER NOT NULL DEFAULT 0,
    line_count      INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT,
    ended_at        TEXT,
    request_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_project ON conversation(project_id, updated_at DESC);

-- --------------------------------------------------------------------------
-- request = ONE user prompt turn. 1 request -> many llm_call rows.
-- Keyed by boundary_index (the nth real prompt in its transcript) so it can be
-- re-derived from the file; generation_id arrives later from the hook side and
-- is the join key back to hook events.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    conversation_id        TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    boundary_index         INTEGER NOT NULL,
    generation_id          TEXT,
    user_query             TEXT NOT NULL,
    prompt_at              TEXT,
    started_at             TEXT,
    ended_at               TEXT,
    status                 TEXT NOT NULL DEFAULT 'in_progress'
                             CHECK(status IN ('in_progress','completed','error','aborted')),
    call_count             INTEGER NOT NULL DEFAULT 0,
    tool_count             INTEGER NOT NULL DEFAULT 0,
    text_chars             INTEGER NOT NULL DEFAULT 0,
    input_tokens           INTEGER,
    output_tokens          INTEGER,
    cache_read_tokens      INTEGER,
    cache_write_tokens     INTEGER,
    model_id               TEXT,
    stop_status            TEXT,
    has_failures           INTEGER NOT NULL DEFAULT 0,
    checks_pass            INTEGER NOT NULL DEFAULT 0,
    checks_fail            INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE(project_id, conversation_id, boundary_index)
);
CREATE INDEX IF NOT EXISTS idx_request_started  ON request(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_status   ON request(project_id, status);
CREATE INDEX IF NOT EXISTS idx_request_failures ON request(project_id, has_failures);
CREATE INDEX IF NOT EXISTS idx_request_gen      ON request(project_id, generation_id);

-- --------------------------------------------------------------------------
-- llm_call = ONE assistant message in the transcript. This is the unit the
-- user asked for: "1 request has how many calls". Transcript-sourced only —
-- its position is what makes it unique, never a re-count.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_call (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    request_id       TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    call_index       INTEGER NOT NULL,
    file_line_no     INTEGER NOT NULL,
    tool_count       INTEGER NOT NULL DEFAULT 0,
    text_chars       INTEGER NOT NULL DEFAULT 0,
    tool_names       TEXT,
    preview          TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE(request_id, call_index),
    UNIQUE(request_id, file_line_no)
);
CREATE INDEX IF NOT EXISTS idx_llm_call_request ON llm_call(request_id, call_index);

-- --------------------------------------------------------------------------
-- event = one hook record (routing evidence). harness distinguishes the two
-- trees that write in parallel; source_line_no is the idempotency anchor.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    harness         TEXT NOT NULL CHECK(harness IN ('cursor','agents')),
    event_type      TEXT NOT NULL,
    tool            TEXT,
    path            TEXT,
    generation_id   TEXT,
    conversation_id TEXT,
    request_id      TEXT REFERENCES request(id) ON DELETE SET NULL,
    hook_at         TEXT,
    source_path     TEXT NOT NULL,
    source_line_no  INTEGER NOT NULL,
    raw_json        TEXT NOT NULL,
    UNIQUE(project_id, harness, source_path, source_line_no)
);
CREATE INDEX IF NOT EXISTS idx_event_request  ON event(request_id, hook_at);
CREATE INDEX IF NOT EXISTS idx_event_gen      ON event(project_id, generation_id);
CREATE INDEX IF NOT EXISTS idx_event_type     ON event(project_id, event_type);
CREATE INDEX IF NOT EXISTS idx_event_convo    ON event(project_id, conversation_id);

-- rules attached to a request, from beforeSubmitPrompt.attachments (type:rule)
CREATE TABLE IF NOT EXISTS request_rule (
    request_id  TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    rule_id     TEXT NOT NULL,
    attached_at TEXT,
    PRIMARY KEY(request_id, rule_id)
);

-- files a request touched, with the strongest action seen
CREATE TABLE IF NOT EXISTS request_file (
    request_id TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    actions    TEXT NOT NULL DEFAULT '',
    reads      INTEGER NOT NULL DEFAULT 0,
    edits      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(request_id, path)
);

-- tools a request used
CREATE TABLE IF NOT EXISTS request_tool (
    request_id TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    tool       TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(request_id, tool)
);

-- conformance verdict per request. check_id mirrors the ids the old viewer used.
CREATE TABLE IF NOT EXISTS check_result (
    request_id TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    check_id   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK(status IN ('pass','fail','warn','skip')),
    heuristic  INTEGER NOT NULL DEFAULT 0,
    detail     TEXT,
    PRIMARY KEY(request_id, check_id)
);
CREATE INDEX IF NOT EXISTS idx_check_status ON check_result(status);

-- hook `stop` aggregates. Kept separate so a re-run can refresh tokens without
-- touching the transcript-derived request spine.
CREATE TABLE IF NOT EXISTS request_stop (
    project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    generation_id  TEXT NOT NULL,
    harness        TEXT NOT NULL,
    model_id       TEXT,
    status         TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    cache_read     INTEGER,
    cache_write    INTEGER,
    conversation_id TEXT,
    hook_at        TEXT,
    PRIMARY KEY(project_id, generation_id, harness)
);

-- prompt text captured by the hook side; the fallback join when a transcript
-- file is missing or its markers changed.
CREATE TABLE IF NOT EXISTS hook_prompt (
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    generation_id   TEXT NOT NULL,
    conversation_id TEXT,
    prompt_text     TEXT,
    rules_json      TEXT,
    hook_at         TEXT,
    PRIMARY KEY(project_id, generation_id)
);
CREATE INDEX IF NOT EXISTS idx_hook_prompt_convo ON hook_prompt(project_id, conversation_id, hook_at);

-- incremental read cursors. Advancing a cursor is the ONLY thing that makes
-- ingest skip work, so it is written in the same transaction as the rows.
CREATE TABLE IF NOT EXISTS ingest_state (
    project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    source_kind   TEXT NOT NULL CHECK(source_kind IN ('transcript','hooks')),
    source_path   TEXT NOT NULL,
    last_size     INTEGER NOT NULL DEFAULT 0,
    last_offset   INTEGER NOT NULL DEFAULT 0,
    last_line_no  INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY(project_id, source_kind, source_path)
);
