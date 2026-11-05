/**
 * @mu/eso-evidence — Configuration Revert & Artefact Marking (ESO-85 / US-EV-02 / Slice S1)
 *
 * Implements:
 * - API-14: POST /v1/config:revert { project, event_id }
 * - AC-EV-02-01: Artefact created in [publish, revert) window is marked with reverted_version and event_id.
 * - AC-EV-02-02: Artefact outside window (before publish or at/after revert) is NOT marked.
 * - AC-EV-02-03: MUTATE_FORBIDDEN: Artefact bytes are NEVER modified. config_event is append-only.
 * - AC-EV-02-04: Empty window returns marked_artifacts: [] with window: { from, to }, no error.
 * - AC-EV-02-05: DANGLING_ARTEFACT: Deleted artefact within window is flagged artefact_state: 'deleted', 0 crash.
 *
 * Invariants:
 * - BR-06: Append-only config_event (no UPDATE / DELETE).
 * - BR-05: empty window != unknown != deleted.
 * - BR-07: Non-blocking (marked = true artefacts remain accessible).
 * - Half-open window: [publish, revert) (closed lower bound, open upper bound).
 * - Idempotency: Repeating revert on same event_id produces identical result.
 */

import crypto from 'node:crypto';

async function queryGet(db, sql, params = []) {
    return await db.get(sql, params);
}

async function queryAll(db, sql, params = []) {
    return await db.all(sql, params);
}

async function queryRun(db, sql, params = []) {
    return await db.run(sql, params);
}

/**
 * Record a configuration save event.
 */
export async function recordConfigSave(db, { project, event_id, version, actor = 'operator', at = new Date().toISOString() }) {
    if (!project || !event_id || version === undefined) {
        throw new Error('project, event_id, and version are required for config save');
    }

    const normProject = project.trim();
    const normEventId = event_id.trim();

    await queryRun(
        db,
        `INSERT INTO config_event (project, event_id, version, kind, marked, actor, at)
         VALUES (?, ?, ?, 'save', '[]', ?, ?)
         ON CONFLICT(project, event_id) DO NOTHING`,
        [normProject, normEventId, Number(version), actor, at]
    );

    return {
        project: normProject,
        event_id: normEventId,
        version: Number(version),
        kind: 'save',
        actor,
        at,
    };
}

/**
 * Revert the latest configuration and mark artefacts created during the reverted version's active window.
 *
 * @param {object} db Database instance
 * @param {object} params Parameters
 * @param {string} params.project Project identifier
 * @param {string} params.event_id Latest save event ID to revert
 * @param {string} [params.revert_event_id] Optional ID for the revert event (generated if missing)
 * @param {string} [params.actor='operator'] Actor invoking the revert
 * @param {string} [params.at] Revert timestamp (defaults to now)
 * @param {number} [params.target_version] Optional target version to revert to
 */
export async function revertConfig(db, {
    project,
    event_id,
    revert_event_id,
    actor = 'operator',
    at = new Date().toISOString(),
    target_version,
}) {
    if (!project || !event_id) {
        throw new Error('project and event_id are required for config revert');
    }

    const normProject = project.trim();
    const normSaveEventId = event_id.trim();
    const revertId = revert_event_id || crypto.randomUUID();

    // Check if this exact revert has already been processed (idempotency)
    const existingRevert = await queryGet(
        db,
        `SELECT * FROM config_event WHERE project = ? AND event_id = ? AND kind = 'revert'`,
        [normProject, revertId]
    );

    if (existingRevert) {
        return {
            reverted_to: existingRevert.version,
            marked_artifacts: JSON.parse(existingRevert.marked || '[]'),
            window: { from: null, to: existingRevert.at },
            idempotent: true,
        };
    }

    // 1. Validate that event_id is the latest save event for project
    const latestSave = await queryGet(
        db,
        `SELECT * FROM config_event
         WHERE project = ? AND kind = 'save'
         ORDER BY at DESC, version DESC
         LIMIT 1`,
        [normProject]
    );

    if (!latestSave || latestSave.event_id !== normSaveEventId) {
        const err = new Error(`NOT_REVERTIBLE: event_id '${normSaveEventId}' is not the latest configuration save`);
        err.code = 'NOT_REVERTIBLE';
        err.status = 409;
        throw err;
    }

    const revertedVersion = latestSave.version;

    // 2. Determine target version to revert to
    let revertedTo = target_version;
    if (revertedTo === undefined) {
        const priorSave = await queryGet(
            db,
            `SELECT version FROM config_event
             WHERE project = ? AND kind = 'save' AND at < ?
             ORDER BY at DESC, version DESC
             LIMIT 1`,
            [normProject, latestSave.at]
        );

        revertedTo = priorSave ? priorSave.version : Math.max(1, revertedVersion - 1);
    }

    // 3. Define the half-open window: [publish_at, revert_at)
    // Lower bound: at >= publish_at
    // Upper bound: at < revert_at
    const publishAt = latestSave.at;
    const revertAt = at;

    // 4. Discover artefacts created in this window
    const turns = await queryAll(
        db,
        `SELECT turn_id, at, payload
         FROM evidence_turn
         WHERE project = ? AND at >= ? AND at < ?
         ORDER BY at ASC`,
        [normProject, publishAt, revertAt]
    );

    const markedMap = new Map();

    for (const turn of turns) {
        let payload = {};
        try {
            payload = typeof turn.payload === 'string' ? JSON.parse(turn.payload) : (turn.payload || {});
        } catch {
            payload = {};
        }

        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        for (const art of artifacts) {
            const artId = typeof art === 'string' ? art : (art.id || art.artefact_id || art.path);
            if (!artId) continue;

            const isDeleted = typeof art === 'object' && Boolean(art.deleted || art.artefact_state === 'deleted' || art.status === 'deleted');

            markedMap.set(artId, {
                artefact_id: artId,
                marked: true,
                event_id: revertId,
                reverted_version: revertedVersion,
                artefact_state: isDeleted ? 'deleted' : 'present',
                ...(isDeleted ? { dangling: true, DANGLING_ARTEFACT: true } : {}),
            });
        }
    }

    const marked_artifacts = Array.from(markedMap.values());

    // 5. Atomic recording of revert event in config_event (BR-06: append-only)
    await queryRun(
        db,
        `INSERT INTO config_event (project, event_id, version, kind, marked, actor, at)
         VALUES (?, ?, ?, 'revert', ?, ?, ?)
         ON CONFLICT(project, event_id) DO NOTHING`,
        [normProject, revertId, Number(revertedTo), JSON.stringify(marked_artifacts), actor, revertAt]
    );

    return {
        reverted_to: Number(revertedTo),
        marked_artifacts,
        window: {
            from: publishAt,
            to: revertAt,
        },
    };
}

/**
 * Re-evaluate marked artefacts for a given revert event at read time.
 * This guarantees late-arriving outbox evidence turns are included dynamically (BIP-11 lines 80-83).
 */
export async function computeMarkedArtefacts(db, { project, revert_event_id }) {
    if (!project || !revert_event_id) {
        throw new Error('project and revert_event_id are required');
    }

    const normProject = project.trim();
    const revertEvent = await queryGet(
        db,
        `SELECT * FROM config_event
         WHERE project = ? AND event_id = ? AND kind = 'revert'`,
        [normProject, revert_event_id]
    );

    if (!revertEvent) {
        return null;
    }

    // Find the save event that was reverted (the latest save prior to revert)
    const saveEvent = await queryGet(
        db,
        `SELECT * FROM config_event
         WHERE project = ? AND kind = 'save' AND at < ?
         ORDER BY at DESC
         LIMIT 1`,
        [normProject, revertEvent.at]
    );

    if (!saveEvent) {
        return JSON.parse(revertEvent.marked || '[]');
    }

    const publishAt = saveEvent.at;
    const revertAt = revertEvent.at;

    const turns = await queryAll(
        db,
        `SELECT turn_id, at, payload
         FROM evidence_turn
         WHERE project = ? AND at >= ? AND at < ?
         ORDER BY at ASC`,
        [normProject, publishAt, revertAt]
    );

    const markedMap = new Map();

    // Start with snapshot from event
    const snapshot = JSON.parse(revertEvent.marked || '[]');
    for (const item of snapshot) {
        markedMap.set(item.artefact_id, item);
    }

    // Incorporate any turns recorded after snapshot
    for (const turn of turns) {
        let payload = {};
        try {
            payload = typeof turn.payload === 'string' ? JSON.parse(turn.payload) : (turn.payload || {});
        } catch {
            payload = {};
        }

        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        for (const art of artifacts) {
            const artId = typeof art === 'string' ? art : (art.id || art.artefact_id || art.path);
            if (!artId || markedMap.has(artId)) continue;

            const isDeleted = typeof art === 'object' && Boolean(art.deleted || art.artefact_state === 'deleted' || art.status === 'deleted');

            markedMap.set(artId, {
                artefact_id: artId,
                marked: true,
                event_id: revert_event_id,
                reverted_version: saveEvent.version,
                artefact_state: isDeleted ? 'deleted' : 'present',
                ...(isDeleted ? { dangling: true, DANGLING_ARTEFACT: true } : {}),
            });
        }
    }

    return Array.from(markedMap.values());
}
