/**
 * @mu/eso-knowledge — Declaration Schema DDL (ESO-125 / 5.1 / Slice S1)
 *
 * Invariants:
 * - BR-10: pool/shared append-only; revert dời con trỏ, không xoá bản.
 * - DM-DECLARATION: Table declaration with primary key (project, kind, path, version).
 * - Closed statuses: 'current', 'superseded', 'revoked'.
 * - Closed kinds: 'skill', 'rule', 'policy', 'agent'.
 */

export const CLOSED_DECLARATION_KINDS = Object.freeze([
    'skill',
    'rule',
    'policy',
    'agent',
]);

export const CLOSED_DECLARATION_STATUSES = Object.freeze([
    'current',
    'superseded',
    'revoked',
]);

export const DECLARATION_SCHEMA_SQL = `
-- Table: declaration (DM-DECLARATION / 5.1)
CREATE TABLE IF NOT EXISTS declaration (
    project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('skill','rule','policy','agent')),
    path TEXT NOT NULL,
    applies_when TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    overrides TEXT NOT NULL DEFAULT '{}',
    proposal_id TEXT,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('current','superseded','revoked')),
    PRIMARY KEY (project, kind, path, version)
);

CREATE INDEX IF NOT EXISTS idx_declaration_lookup
ON declaration(project, kind, status);

CREATE INDEX IF NOT EXISTS idx_declaration_path
ON declaration(project, path, version);

-- Triggers: BR-10 immutability enforcement
CREATE OR REPLACE FUNCTION declaration_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'BR-10: declaration is append-only. DELETE is forbidden.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_declaration_no_delete ON declaration;
CREATE TRIGGER trg_declaration_no_delete
BEFORE DELETE ON declaration
FOR EACH ROW EXECUTE FUNCTION declaration_append_only();
`;

export const DECLARATION_POSTGRES_RLS_SQL = `
ALTER TABLE declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaration FORCE ROW LEVEL SECURITY;
CREATE POLICY declaration_project_only ON declaration
    FOR ALL
    USING (project = current_setting('eso.project', true) OR project = 'shared' OR project = 'pool');
`;

export async function initDeclarationSchema(db) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database handle with exec() is required');
    }
    await db.exec(DECLARATION_SCHEMA_SQL);
}
