/**
 * @mu/eso-control-plane — Configuration Storage Schema (PostgreSQL)
 *
 * Implements T-04.2 (ESO-369) with D-93: PostgreSQL only, no SQLite.
 */

export const CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_record (
    project TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    content_json TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'system',
    saved_at TIMESTAMPTZ NOT NULL,
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
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_event_project ON config_event(project);

CREATE OR REPLACE FUNCTION config_event_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'config_event is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_config_event_change ON config_event;
CREATE TRIGGER trg_prevent_config_event_change
BEFORE UPDATE OR DELETE ON config_event
FOR EACH ROW EXECUTE FUNCTION config_event_append_only();
`;

export async function initConfigSchema(db) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database with .exec() method is required to initialize config schema');
    }
    await db.exec(CONFIG_SCHEMA_SQL);
}
