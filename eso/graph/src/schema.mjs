/**
 * eso/graph schema — DDL and invariants for ESO Graph Architecture (ESO-40 / Slice S1).
 *
 * Invariants:
 * - INV-GR-02: AST model is the single source of truth for static relationships.
 * - INV-GR-03: All nodes/edges tagged with `project`; project isolation at DB level.
 * - BR-05: unknown != absent: completeness is NOT NULL, covered < total rendered as unknown + coverage, never absent.
 * - BR-06: source_claim is strictly append-only, UPDATE/DELETE prohibited via trigger, no parallel `sources` column.
 */

export const SCHEMA_SQL = `
-- 1. graph_node: AST nodes, files, symbols, modules
CREATE TABLE IF NOT EXISTS graph_node (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_node_project_kind ON graph_node(project, kind);
CREATE INDEX IF NOT EXISTS idx_graph_node_path ON graph_node(path);

-- 2. graph_edge: static relationships between nodes
CREATE TABLE IF NOT EXISTS graph_edge (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES graph_node(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES graph_node(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_edge_project ON graph_edge(project);
CREATE INDEX IF NOT EXISTS idx_graph_edge_source ON graph_edge(source_id);
CREATE INDEX IF NOT EXISTS idx_graph_edge_target ON graph_edge(target_id);

-- 3. source_claim: claims originating from sources (strictly append-only, BR-06)
-- NOTE: Intentionally NO 'sources' column to uphold BR-06 (no parallel sources column).
CREATE TABLE IF NOT EXISTS source_claim (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES graph_node(id) ON DELETE CASCADE,
    claim_type TEXT NOT NULL,
    claim_payload TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_claim_project ON source_claim(project);
CREATE INDEX IF NOT EXISTS idx_source_claim_node ON source_claim(node_id);

-- BR-06: Trigger enforcing append-only on source_claim (prevent UPDATE)
CREATE TRIGGER IF NOT EXISTS trg_prevent_source_claim_update
BEFORE UPDATE ON source_claim
BEGIN
    SELECT RAISE(ABORT, 'BR-06 violation: source_claim is append-only, UPDATE is prohibited');
END;

-- BR-06: Trigger enforcing append-only on source_claim (prevent DELETE)
CREATE TRIGGER IF NOT EXISTS trg_prevent_source_claim_delete
BEFORE DELETE ON source_claim
BEGIN
    SELECT RAISE(ABORT, 'BR-06 violation: source_claim is append-only, DELETE is prohibited');
END;

-- 4. completeness: completeness records per question per project (BR-05)
CREATE TABLE IF NOT EXISTS completeness (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    question_id TEXT NOT NULL,
    value REAL NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT DEFAULT '{}',
    calculated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_completeness_project_question ON completeness(project, question_id);
`;

export const POSTGRES_RLS_SQL = `
-- PostgreSQL RLS policies for project isolation (INV-GR-03)
ALTER TABLE graph_node ENABLE ROW LEVEL SECURITY;
CREATE POLICY graph_node_project_isolation ON graph_node
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE graph_edge ENABLE ROW LEVEL SECURITY;
CREATE POLICY graph_edge_project_isolation ON graph_edge
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE source_claim ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_claim_project_isolation ON source_claim
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE completeness ENABLE ROW LEVEL SECURITY;
CREATE POLICY completeness_project_isolation ON completeness
    FOR ALL
    USING (project = current_setting('eso.project', true));
`;

export const TABLES = Object.freeze([
    'graph_node',
    'graph_edge',
    'source_claim',
    'completeness',
]);

/**
 * Initialize database schema idempotently.
 * Supports bun:sqlite Database, node:sqlite DatabaseSync, and SqliteDb.
 * @param {{ exec: (sql: string) => void }} db
 */
export function initSchema(db) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database connection with exec() method required');
    }
    db.exec(SCHEMA_SQL);
}
