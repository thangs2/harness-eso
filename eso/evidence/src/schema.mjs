/**
 * @mu/eso-evidence — Schema DDL & Append-Only Triggers (ESO-65 / US-EV-01 / Slice S1)
 *
 * Invariants:
 * - BR-06: evidence_turn, evidence_item, evidence_risk are append-only.
 *   UPDATE and DELETE are strictly forbidden and aborted via database triggers.
 * - INV-EV-01: Idempotent batch insertion on (project, turn_id) and (project, turn_id, seq).
 * - INV-EV-02: Project boundary isolation enforced on all tables.
 * - Closed constraints on level, mode, basis, actor_status, item.kind, risk.event.
 */

export const CLOSED_LEVELS = Object.freeze([
    'insufficient',
    'partial',
    'sufficient',
    'cannot-judge',
    'unsurfaced',
]);

export const CLOSED_MODES = Object.freeze([
    'block',
    'ask',
    'do',
    'permitted',
    'bypassed',
]);

export const CLOSED_BASES = Object.freeze([
    'retrieved',
    'verified',
    'inferred',
]);

export const CLOSED_ACTOR_STATUSES = Object.freeze([
    'FULL',
    'DECLARED',
    'DEGRADED',
]);

export const CLOSED_ITEM_KINDS = Object.freeze([
    'claim',
    'election',
    'gap',
    'authz',
    'refusal',
    'warning',
    'state_snapshot',
]);

export const CLOSED_RISK_EVENTS = Object.freeze([
    'open',
    'opened',
    'accept',
    'accepted',
    'mitigate',
    'mitigated',
    'close',
    'closed',
    'reopen',
    'reopened',
]);

export const EVIDENCE_TABLES = Object.freeze([
    'evidence_turn',
    'evidence_item',
    'evidence_risk',
    'config_event',
]);

export const SCHEMA_SQL = `
-- 1. evidence_turn: single turn level, mode, basis, rule_version, payload
CREATE TABLE IF NOT EXISTS evidence_turn (
    project TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    actor_status TEXT NOT NULL CHECK(actor_status IN ('FULL','DECLARED','DEGRADED')),
    level TEXT NOT NULL CHECK(level IN ('insufficient','partial','sufficient','cannot-judge','unsurfaced')),
    mode TEXT NOT NULL CHECK(mode IN ('block','ask','do','permitted','bypassed')),
    basis TEXT NOT NULL CHECK(basis IN ('retrieved','verified','inferred')),
    rule_version TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (project, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_turn_project_at ON evidence_turn(project, at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_turn_level ON evidence_turn(project, level);

-- 2. evidence_item: items within a turn (elections, claims, gaps, authz, etc.)
CREATE TABLE IF NOT EXISTS evidence_item (
    project TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK(seq >= 1),
    kind TEXT NOT NULL CHECK(kind IN ('claim','election','gap','authz','refusal','warning','state_snapshot')),
    payload TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (project, turn_id) REFERENCES evidence_turn(project, turn_id) ON DELETE CASCADE,
    PRIMARY KEY (project, turn_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_evidence_item_kind ON evidence_item(project, kind);

-- 3. evidence_risk: risk lifecycle events (open, accept, mitigate, close, reopen)
CREATE TABLE IF NOT EXISTS evidence_risk (
    project TEXT NOT NULL,
    risk_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK(seq >= 1),
    at TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('open','opened','accept','accepted','mitigate','mitigated','close','closed','reopen','reopened')),
    actor TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (project, risk_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_evidence_risk_project_id ON evidence_risk(project, risk_id);

-- Append-Only Triggers (BR-06) — PostgreSQL trigger function, D-93.
CREATE OR REPLACE FUNCTION raise_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'BR-06: % is append-only. % is forbidden.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evidence_turn_no_change ON evidence_turn;
CREATE TRIGGER trg_evidence_turn_no_change
BEFORE UPDATE OR DELETE ON evidence_turn
FOR EACH ROW EXECUTE FUNCTION raise_evidence_append_only();

DROP TRIGGER IF EXISTS trg_evidence_item_no_change ON evidence_item;
CREATE TRIGGER trg_evidence_item_no_change
BEFORE UPDATE OR DELETE ON evidence_item
FOR EACH ROW EXECUTE FUNCTION raise_evidence_append_only();

DROP TRIGGER IF EXISTS trg_evidence_risk_no_change ON evidence_risk;
CREATE TRIGGER trg_evidence_risk_no_change
BEFORE UPDATE OR DELETE ON evidence_risk
FOR EACH ROW EXECUTE FUNCTION raise_evidence_append_only();

`;

/**
 * The evidence plane's own config_event. D-73 gives control plane and ctx separate stores, but a
 * single PostgreSQL schema holds one `config_event` name: the control plane's row shape
 * (id/event_type/created_at) and the evidence row shape (event_id/kind/marked/at) cannot share a
 * table. `initEvidenceSchema` therefore creates this table only when the name is free; when a
 * control-plane store already owns `config_event`, the evidence tables still come up and the
 * evidence revert API is simply not part of that database.
 */
export const CONFIG_EVENT_SQL = `
CREATE TABLE IF NOT EXISTS config_event (
    project TEXT NOT NULL,
    event_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('save', 'revert')),
    marked TEXT NOT NULL DEFAULT '[]',
    actor TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (project, event_id)
);

CREATE INDEX IF NOT EXISTS idx_config_event_project_at ON config_event(project, at DESC);

DROP TRIGGER IF EXISTS trg_config_event_no_change ON config_event;
CREATE TRIGGER trg_config_event_no_change
BEFORE UPDATE OR DELETE ON config_event
FOR EACH ROW EXECUTE FUNCTION raise_evidence_append_only();
`;

export const POSTGRES_RLS_SQL = `
ALTER TABLE evidence_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_turn FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS turn_project_only ON evidence_turn;
CREATE POLICY turn_project_only ON evidence_turn
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE evidence_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_project_only ON evidence_item;
CREATE POLICY item_project_only ON evidence_item
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE evidence_risk ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_risk FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS risk_project_only ON evidence_risk;
CREATE POLICY risk_project_only ON evidence_risk
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE config_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_event_project_only ON config_event;
CREATE POLICY config_event_project_only ON config_event
    FOR ALL
    USING (project = current_setting('eso.project', true));
`;

/**
 * Create the evidence tables. PostgreSQL only (D-93): the SQLite trigger syntax this
 * module carried until the D-93 migration is gone, so an old SQLite handle cannot pass.
 *
 * RLS is opt-in: enabling it requires every session to set `eso.project`, which belongs to
 * the adapter that opens the connection (see eso/graph/src/schema.mjs for the pattern).
 */
export async function initEvidenceSchema(db, { enableRls = false } = {}) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database handle with async exec() is required (PostgreSQL, D-93)');
    }
    await db.exec(SCHEMA_SQL);
    const configEvent = await db.get(`SELECT to_regclass('config_event') AS oid`);
    if (!configEvent || !configEvent.oid) await db.exec(CONFIG_EVENT_SQL);
    if (enableRls) await db.exec(POSTGRES_RLS_SQL);
}
