/**
 * @mu/eso-control-plane — Configuration Storage Schema
 *
 * Implements T-04.2 (ESO-369): DDL and append-only event schema for config store.
 */

export const CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_record (
    project TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    content_json TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'system',
    saved_at TEXT NOT NULL,
    PRIMARY KEY (project, version)
);

CREATE INDEX IF NOT EXISTS idx_config_record_project ON config_record(project);

CREATE TABLE IF NOT EXISTS config_event (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_event_project ON config_event(project);

-- Invariant: config_event is strictly append-only (prevent UPDATE)
CREATE TRIGGER IF NOT EXISTS trg_prevent_config_event_update
BEFORE UPDATE ON config_event
BEGIN
    SELECT RAISE(ABORT, 'config_event is append-only: UPDATE is forbidden');
END;

-- Invariant: config_event is strictly append-only (prevent DELETE)
CREATE TRIGGER IF NOT EXISTS trg_prevent_config_event_delete
BEFORE DELETE ON config_event
BEGIN
    SELECT RAISE(ABORT, 'config_event is append-only: DELETE is forbidden');
END;
`;

export function initConfigSchema(db) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database with .exec() method is required to initialize config schema');
    }
    db.exec(CONFIG_SCHEMA_SQL);
}
