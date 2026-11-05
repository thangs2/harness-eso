/**
 * eso/graph schema — DDL and invariants for ESO Graph Architecture (ESO-447).
 *
 * Implements:
 * - D-92 / D-93 / D-73: PostgreSQL graph database target from `sdlc/07.technical/02.data-design/26.graph-schema.md`.
 * - INV-GR-02: AST model is the single source of truth for static relationships.
 * - INV-GR-03: All nodes/edges tagged with `project`; project isolation via RLS (ENABLE + FORCE).
 * - BR-05: unknown != absent: completeness is NOT NULL, covered < total rendered as unknown + coverage, never absent.
 * - BR-06: source_claim is strictly append-only, UPDATE/DELETE prohibited via trigger, no parallel `sources` column.
 */

export const SCHEMA_SQL = `
-- 1. graph_node: node của code graph + docs graph
CREATE TABLE IF NOT EXISTS graph_node (
  project   text NOT NULL,
  build_id  text NOT NULL,
  node_id   text NOT NULL,
  kind      text NOT NULL,
  node_key  text NOT NULL,
  path      text,
  PRIMARY KEY (project, build_id, node_id),
  CONSTRAINT graph_node_kind_closed CHECK (kind IN
    ('module','namespace','class','method','entity','dto','table',
     'endpoint','permission','app_service','service','route','doc')),
  CONSTRAINT graph_node_key_unique UNIQUE (project, build_id, kind, node_key)
);

CREATE INDEX IF NOT EXISTS idx_graph_node_kind ON graph_node (project, build_id, kind);
CREATE INDEX IF NOT EXISTS idx_graph_node_path ON graph_node (project, build_id, path);

-- 2. graph_edge: quan hệ có hướng; KHÔNG có cột nguồn (D-25 / BR-06)
CREATE TABLE IF NOT EXISTS graph_edge (
  project      text NOT NULL,
  build_id     text NOT NULL,
  edge_id      text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id   text NOT NULL,
  kind         text NOT NULL,
  conflict     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project, build_id, edge_id),
  CONSTRAINT graph_edge_kind_closed CHECK (kind IN
    ('references','maps_to','depends_on','requires','defines',
     'tenant_marker','specifies','constrains','supersedes')),
  CONSTRAINT graph_edge_from_node_fk FOREIGN KEY (project, build_id, from_node_id)
    REFERENCES graph_node (project, build_id, node_id),
  CONSTRAINT graph_edge_to_node_fk FOREIGN KEY (project, build_id, to_node_id)
    REFERENCES graph_node (project, build_id, node_id),
  CONSTRAINT graph_edge_unique_triple UNIQUE (project, build_id, from_node_id, to_node_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_graph_edge_from ON graph_edge (project, build_id, from_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edge_to ON graph_edge (project, build_id, to_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edge_kind ON graph_edge (project, build_id, kind);

-- 3. source_claim: provenance của edge, CHỈ ghi thêm (BR-06)
CREATE TABLE IF NOT EXISTS source_claim (
  project     text NOT NULL,
  build_id    text NOT NULL,
  edge_id     text NOT NULL,
  seq         int  NOT NULL,
  source_kind text NOT NULL,
  claim       text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, build_id, edge_id, seq),
  CONSTRAINT source_claim_seq_positive CHECK (seq >= 1),
  CONSTRAINT source_claim_source_kind_closed CHECK (source_kind IN ('roslyn','docs'))
);

CREATE INDEX IF NOT EXISTS idx_source_claim_kind ON source_claim (project, build_id, source_kind);

CREATE OR REPLACE FUNCTION raise_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'BR-06 violation: source_claim is append-only, UPDATE and DELETE are prohibited (APPEND_ONLY)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_source_claim_no_change ON source_claim;
CREATE TRIGGER trg_source_claim_no_change
BEFORE UPDATE OR DELETE ON source_claim
FOR EACH ROW EXECUTE FUNCTION raise_append_only();

-- 4. completeness: MỘT dòng cho mỗi (build, câu hỏi) — BR-05
CREATE TABLE IF NOT EXISTS completeness (
  project     text NOT NULL,
  build_id    text NOT NULL,
  question    text NOT NULL,
  per_kind    jsonb NOT NULL,
  value       numeric(4,3) NOT NULL,
  measured_at timestamptz NOT NULL,
  PRIMARY KEY (project, build_id, question),
  CONSTRAINT completeness_question_closed CHECK (question IN ('Q1','Q2','Q3','Q4','Q5')),
  CONSTRAINT completeness_value_range CHECK (value >= 0 AND value <= 1),
  CONSTRAINT completeness_per_kind_object CHECK (jsonb_typeof(per_kind) = 'object')
);
`;

export const POSTGRES_RLS_SQL = `
-- 5. Cô lập project (RLS) — ENABLE + FORCE + WITH CHECK (INV-GR-03 / 26.graph-schema.md §5)
ALTER TABLE graph_node   ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_node   FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_edge   ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edge   FORCE ROW LEVEL SECURITY;
ALTER TABLE source_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_claim FORCE ROW LEVEL SECURITY;
ALTER TABLE completeness ENABLE ROW LEVEL SECURITY;
ALTER TABLE completeness FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_node_project_only ON graph_node;
CREATE POLICY graph_node_project_only ON graph_node
  FOR ALL
  USING      (project = current_setting('eso.project', true))
  WITH CHECK (project = current_setting('eso.project', true));

DROP POLICY IF EXISTS graph_edge_project_only ON graph_edge;
CREATE POLICY graph_edge_project_only ON graph_edge
  FOR ALL
  USING      (project = current_setting('eso.project', true))
  WITH CHECK (project = current_setting('eso.project', true));

DROP POLICY IF EXISTS source_claim_project_only ON source_claim;
CREATE POLICY source_claim_project_only ON source_claim
  FOR ALL
  USING      (project = current_setting('eso.project', true))
  WITH CHECK (project = current_setting('eso.project', true));

DROP POLICY IF EXISTS completeness_project_only ON completeness;
CREATE POLICY completeness_project_only ON completeness
  FOR ALL
  USING      (project = current_setting('eso.project', true))
  WITH CHECK (project = current_setting('eso.project', true));
`;

export const TABLES = Object.freeze([
  'graph_node',
  'graph_edge',
  'source_claim',
  'completeness',
]);

/**
 * Initialize graph database schema in PostgreSQL (idempotent).
 *
 * @param {object} db - Database adapter instance
 * @param {object} [options={}]
 * @param {boolean} [options.enableRls=true]
 */
export async function initSchema(db, options = {}) {
  if (!db || typeof db.exec !== 'function') {
    throw new Error('Database instance with .exec() method is required');
  }

  await db.exec(SCHEMA_SQL);

  const shouldEnableRls = options.enableRls !== false;
  if (shouldEnableRls) {
    // Fail closed: a role that cannot enable RLS must not silently run without project isolation.
    await db.exec(POSTGRES_RLS_SQL);
  }
}
