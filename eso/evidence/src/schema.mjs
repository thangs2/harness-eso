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

-- 4. config_event: configuration save and revert history (API-14 / US-EV-02 / DM-CONFIG-EVENT)
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

-- Append-Only Triggers (BR-06)
CREATE TRIGGER IF NOT EXISTS trg_evidence_turn_no_update
BEFORE UPDATE ON evidence_turn
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_turn is append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_turn_no_delete
BEFORE DELETE ON evidence_turn
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_turn is append-only. DELETE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_item_no_update
BEFORE UPDATE ON evidence_item
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_item is append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_item_no_delete
BEFORE DELETE ON evidence_item
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_item is append-only. DELETE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_risk_no_update
BEFORE UPDATE ON evidence_risk
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_risk is append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_risk_no_delete
BEFORE DELETE ON evidence_risk
BEGIN
    SELECT RAISE(ABORT, 'BR-06: evidence_risk is append-only. DELETE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_config_event_no_update
BEFORE UPDATE ON config_event
BEGIN
    SELECT RAISE(ABORT, 'BR-06: config_event is append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_config_event_no_delete
BEFORE DELETE ON config_event
BEGIN
    SELECT RAISE(ABORT, 'BR-06: config_event is append-only. DELETE is forbidden.');
END;
`;

export const POSTGRES_RLS_SQL = `
ALTER TABLE evidence_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_turn FORCE ROW LEVEL SECURITY;
CREATE POLICY turn_project_only ON evidence_turn
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE evidence_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_item FORCE ROW LEVEL SECURITY;
CREATE POLICY item_project_only ON evidence_item
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE evidence_risk ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_risk FORCE ROW LEVEL SECURITY;
CREATE POLICY risk_project_only ON evidence_risk
    FOR ALL
    USING (project = current_setting('eso.project', true));

ALTER TABLE config_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_event FORCE ROW LEVEL SECURITY;
CREATE POLICY config_event_project_only ON config_event
    FOR ALL
    USING (project = current_setting('eso.project', true));
`;

export function initEvidenceSchema(db) {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database handle with exec() is required');
    }
    db.exec(SCHEMA_SQL);
}
