import { randomUUID } from 'node:crypto';

/**
 * @mu/eso-adapters — Host Bridge & Evidence Turn Ingestion
 *
 * Implements:
 * - Table schema creation for `evidence_turn` (DM-EVIDENCE-TURN)
 * - Turn evidence recording (append-only)
 * - Replay & querying of historical turn evidence
 */

export function ensureEvidenceSchema(db) {
    if (!db) throw new Error('Database instance required');

    const ddl = `
        CREATE TABLE IF NOT EXISTS evidence_turn (
            project      TEXT NOT NULL,
            turn_id      TEXT NOT NULL,
            at           TEXT NOT NULL,
            actor_role   TEXT NOT NULL,
            actor_status TEXT NOT NULL,
            level        TEXT NOT NULL,
            mode         TEXT NOT NULL,
            basis        TEXT NOT NULL,
            rule_version TEXT NOT NULL,
            payload      TEXT NOT NULL,
            PRIMARY KEY (project, turn_id)
        );
    `;

    if (typeof db.exec === 'function') {
        db.exec(ddl);
    } else if (typeof db.run === 'function') {
        db.run(ddl);
    }
}

export function recordTurnEvidence({
    db,
    project,
    turnId = randomUUID(),
    at = new Date().toISOString(),
    actorRole = 'operator',
    actorStatus = 'FULL',
    level = 'sufficient',
    mode = 'do',
    basis = 'verified',
    ruleVersion = '2.0.0',
    payload = {},
} = {}) {
    if (!db) throw new Error('db is required');
    if (!project) throw new Error('project is required');

    ensureEvidenceSchema(db);

    const validLevels = ['insufficient', 'partial', 'sufficient', 'cannot-judge', 'unsurfaced'];
    if (!validLevels.includes(level)) {
        throw new Error(`INVALID_LEVEL: Level '${level}' must be one of ${validLevels.join(', ')}`);
    }

    const validModes = ['block', 'ask', 'do', 'permitted', 'bypassed'];
    if (!validModes.includes(mode)) {
        throw new Error(`INVALID_MODE: Mode '${mode}' must be one of ${validModes.join(', ')}`);
    }

    const validBases = ['retrieved', 'verified', 'inferred'];
    if (!validBases.includes(basis)) {
        throw new Error(`INVALID_BASIS: Basis '${basis}' must be one of ${validBases.join(', ')}`);
    }

    const validActorStatuses = ['FULL', 'DECLARED', 'DEGRADED'];
    if (!validActorStatuses.includes(actorStatus)) {
        throw new Error(`INVALID_ACTOR_STATUS: actorStatus '${actorStatus}' must be one of ${validActorStatuses.join(', ')}`);
    }

    const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const sql = `
        INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        project,
        turnId,
        at,
        actorRole,
        actorStatus,
        level,
        mode,
        basis,
        ruleVersion,
        payloadJson,
    ];

    if (typeof db.run === 'function') {
        db.run(sql, ...params);
    } else if (typeof db.prepare === 'function') {
        db.prepare(sql).run(...params);
    }

    return {
        project,
        turn_id: turnId,
        at,
        actor_role: actorRole,
        actor_status: actorStatus,
        level,
        mode,
        basis,
        rule_version: ruleVersion,
        payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
    };
}

export function readTurnEvidence({
    db,
    project,
    turnId,
} = {}) {
    if (!db) throw new Error('db is required');
    if (!project) throw new Error('project is required');
    if (!turnId) throw new Error('turnId is required');

    ensureEvidenceSchema(db);

    const sql = `SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ? LIMIT 1`;
    let row = null;

    if (typeof db.get === 'function') {
        row = db.get(sql, project, turnId);
    } else if (typeof db.prepare === 'function') {
        row = db.prepare(sql).get(project, turnId);
    }

    if (!row) return null;

    return {
        project: row.project,
        turn_id: row.turn_id,
        at: row.at,
        actor_role: row.actor_role,
        actor_status: row.actor_status,
        level: row.level,
        mode: row.mode,
        basis: row.basis,
        rule_version: row.rule_version,
        payload: JSON.parse(row.payload || '{}'),
    };
}

export function listTurnEvidence({
    db,
    project,
    limit = 50,
} = {}) {
    if (!db) throw new Error('db is required');
    if (!project) throw new Error('project is required');

    ensureEvidenceSchema(db);

    const sql = `SELECT * FROM evidence_turn WHERE project = ? ORDER BY at DESC LIMIT ?`;
    let rows = [];

    if (typeof db.all === 'function') {
        rows = db.all(sql, project, limit);
    } else if (typeof db.prepare === 'function') {
        rows = db.prepare(sql).all(project, limit);
    }

    return rows.map((row) => ({
        project: row.project,
        turn_id: row.turn_id,
        at: row.at,
        actor_role: row.actor_role,
        actor_status: row.actor_status,
        level: row.level,
        mode: row.mode,
        basis: row.basis,
        rule_version: row.rule_version,
        payload: JSON.parse(row.payload || '{}'),
    }));
}
