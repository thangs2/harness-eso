-- 004_event_any_harness.sql — drop the two-harness ceiling on `event`.
--
-- `event.harness` was born with CHECK(harness IN ('cursor','agents')). That single
-- line was the most anti-generic thing in the schema: it makes a third IDE
-- impossible to RECORD even after every other layer learned about it, and it failed
-- in exactly that way — an Antigravity session could not be stored because the DB
-- rejected the row before any tooling got a say. A harness id is an open identifier
-- owned by `harness.config.json § ingest.harnesses`, so the column becomes plain TEXT.
--
-- SQLite cannot drop a CHECK constraint, so the table is rebuilt. Nothing references
-- `event` by foreign key (it is a leaf child of `request`), and `id` values are copied
-- explicitly so AUTOINCREMENT continuity survives the rebuild. `PRAGMA foreign_keys`
-- is deliberately NOT toggled: migrations run inside a transaction, where that pragma
-- is a silent no-op, so relying on it would be worse than not using it.
CREATE TABLE event_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    harness         TEXT NOT NULL,
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

INSERT INTO event_new (id, project_id, harness, event_type, tool, path, generation_id,
                       conversation_id, request_id, hook_at, source_path, source_line_no, raw_json)
SELECT id, project_id, harness, event_type, tool, path, generation_id,
       conversation_id, request_id, hook_at, source_path, source_line_no, raw_json
FROM event;

DROP TABLE event;
ALTER TABLE event_new RENAME TO event;

CREATE INDEX IF NOT EXISTS idx_event_request  ON event(request_id, hook_at);
CREATE INDEX IF NOT EXISTS idx_event_gen      ON event(project_id, generation_id);
CREATE INDEX IF NOT EXISTS idx_event_type     ON event(project_id, event_type);
CREATE INDEX IF NOT EXISTS idx_event_convo    ON event(project_id, conversation_id);
