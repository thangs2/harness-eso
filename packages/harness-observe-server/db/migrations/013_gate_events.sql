-- 013_gate_events.sql — one row per gate decision the runtime made.
--
-- Until now a blocked write existed only in `~/.harness/eso-blockers.jsonl` on the host: the
-- Observatory could not show it, and the host itself logs nothing when it blocks a tool. This table is
-- that trail made queryable. `source_path` + `source_line_no` make ingestion idempotent, the same way
-- the transcript and hook spines work.
CREATE TABLE IF NOT EXISTS gate_event (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    at             TEXT,
    kind           TEXT NOT NULL,
    host           TEXT,
    event          TEXT,
    tool           TEXT,
    ref            TEXT,
    detail         TEXT,
    blockers_json  TEXT,
    raw_json       TEXT NOT NULL,
    source_path    TEXT NOT NULL,
    source_line_no INTEGER NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE(project_id, source_path, source_line_no)
);

CREATE INDEX IF NOT EXISTS idx_gate_event_at ON gate_event(project_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_event_kind ON gate_event(project_id, kind, at DESC);
