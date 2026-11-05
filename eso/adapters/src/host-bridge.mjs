import { randomUUID } from 'node:crypto';

import { initEvidenceSchema } from '../../evidence/src/schema.mjs';

/**
 * @mu/eso-adapters — Host Bridge & Evidence Turn Ingestion (D-93: PostgreSQL only)
 *
 * Implements:
 * - Table schema creation for `evidence_turn` — delegated to the canonical
 *   `eso/evidence/src/schema.mjs` so the host bridge and the recorder cannot drift.
 * - Turn evidence recording (append-only)
 * - Replay & querying of historical turn evidence
 *
 * Every function is async: the store is PostgreSQL via `createDbAdapter`, whose
 * run/get/all/exec are promises. There is no SQLite branch and no fallback.
 */

export async function ensureEvidenceSchema(db) {
    if (!db) throw new Error('Database instance required');
    await initEvidenceSchema(db);
}

export async function recordTurnEvidence({
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

    await ensureEvidenceSchema(db);

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

    await db.run(
        `INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [project, turnId, at, actorRole, actorStatus, level, mode, basis, ruleVersion, payloadJson],
    );

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

export async function readTurnEvidence({
    db,
    project,
    turnId,
} = {}) {
    if (!db) throw new Error('db is required');
    if (!project) throw new Error('project is required');
    if (!turnId) throw new Error('turnId is required');

    await ensureEvidenceSchema(db);

    const row = await db.get(
        'SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ? LIMIT 1',
        [project, turnId],
    );

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

export async function listTurnEvidence({
    db,
    project,
    limit = 50,
} = {}) {
    if (!db) throw new Error('db is required');
    if (!project) throw new Error('project is required');

    await ensureEvidenceSchema(db);

    const rows = await db.all(
        'SELECT * FROM evidence_turn WHERE project = ? ORDER BY at DESC LIMIT ?',
        [project, limit],
    );

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
