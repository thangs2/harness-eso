import { createHash, randomUUID } from 'node:crypto';
import { initConfigSchema } from '../config.schema.js';

/**
 * Compute deterministic hash of config content.
 */
export function computeConfigHash(content) {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Save configuration change with versioning, hash verification, and append-only event trail.
 *
 * Requirements (T-04.2 / ESO-369):
 * - save -> read đúng hash
 * - hash cũ -> STALE_VERSION
 * - version +1 mỗi save
 * - event append-only
 */
export async function saveConfig(db, {
    project,
    config,
    expectedHash = null,
    operator = 'operator',
}: any = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('Project is required');
    }
    if (!config || typeof config !== 'object') {
        throw new Error('Config object is required');
    }

    const normProject = project.trim();
    const current = await getLatestConfig(db, normProject);

    if (current) {
        if (expectedHash !== null && expectedHash !== current.hash) {
            const err: any = new Error(`STALE_VERSION: Expected hash "${expectedHash}" does not match current hash "${current.hash}" (version ${current.version})`);
            err.code = 'STALE_VERSION';
            err.current_hash = current.hash;
            err.current_version = current.version;
            throw err;
        }
    } else if (expectedHash !== null) {
        const err: any = new Error(`STALE_VERSION: Project "${normProject}" has no prior version, expected hash "${expectedHash}" is invalid`);
        err.code = 'STALE_VERSION';
        throw err;
    }

    const newVersion = current ? current.version + 1 : 1;
    const contentToStore = {
        ...config,
        project: normProject,
        version: newVersion,
    };
    const newHash = computeConfigHash(contentToStore);
    const now = new Date().toISOString();

    await db.run(
        `INSERT INTO config_record (project, version, hash, content_json, operator, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [normProject, newVersion, newHash, JSON.stringify(contentToStore), operator, now]
    );

    const eventId = `ev_${randomUUID()}`;
    await db.run(
        `INSERT INTO config_event (id, project, version, hash, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [eventId, normProject, newVersion, newHash, 'SAVE', JSON.stringify({ operator, previous_version: current?.version ?? null }), now]
    );

    return {
        project: normProject,
        version: newVersion,
        hash: newHash,
        config: contentToStore,
        saved_at: now,
    };
}

/**
 * Retrieve configuration for project, either at specific version or latest.
 */
export async function readConfig(db, project, version = null) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('Project is required');
    }
    const normProject = project.trim();

    let row;
    if (version !== null) {
        row = await db.get(
            `SELECT project, version, hash, content_json, operator, saved_at
             FROM config_record
             WHERE project = ? AND version = ?`,
            [normProject, Number(version)]
        );
    } else {
        row = await db.get(
            `SELECT project, version, hash, content_json, operator, saved_at
             FROM config_record
             WHERE project = ?
             ORDER BY version DESC
             LIMIT 1`,
            [normProject]
        );
    }

    if (!row) {
        return null;
    }

    return {
        project: row.project,
        version: row.version,
        hash: row.hash,
        config: JSON.parse(row.content_json),
        operator: row.operator,
        saved_at: row.saved_at,
    };
}

export async function getLatestConfig(db, project) {
    return readConfig(db, project);
}

/**
 * List audit events for project configuration (append-only).
 */
export async function listConfigEvents(db, project) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('Project is required');
    }
    const normProject = project.trim();
    const rows = await db.all(
        `SELECT id, project, version, hash, event_type, payload_json, created_at
         FROM config_event
         WHERE project = ?
         ORDER BY version ASC, created_at ASC`,
        [normProject]
    ) || [];

    return rows.map((r) => ({
        id: r.id,
        project: r.project,
        version: r.version,
        hash: r.hash,
        event_type: r.event_type,
        payload: JSON.parse(r.payload_json || '{}'),
        created_at: r.created_at,
    }));
}
