/**
 * @mu/eso-evidence — Evidence Recorder & Reader (ESO-65 / US-EV-01 / Slice S1)
 *
 * Invariants & ACs:
 * - AC-EV-01-01: Ghi turn có level, mode, basis, Resolved[], FileUse{hash, commit, dirty}.
 * - AC-EV-01-02 / BR-06: Append-only, sửa/xóa bị từ chối với APPEND_ONLY.
 * - AC-EV-01-03: File chưa commit có dirty: true, ghi chú rõ "nội dung không lấy lại được".
 * - AC-EV-01-04: Tenant isolation, không thấy record của project khác (OUT_OF_SCOPE).
 * - AC-EV-01-05: RBAC: Chỉ runtime ghi được trực tiếp vào evidence (DIRECT_WRITE_FORBIDDEN).
 * - AC-EV-01-06 / ED6: Cùng batch gửi 2 lần -> idempotent, không tạo bản ghi thứ hai.
 * - AC-EV-01-07 / ED10: FileUse trỏ file đã xóa -> giữ hash + commit, khi đọc báo cờ gone: true.
 */

import {
    CLOSED_LEVELS,
    CLOSED_MODES,
    CLOSED_BASES,
    CLOSED_ACTOR_STATUSES,
    CLOSED_ITEM_KINDS,
} from './schema.mjs';

/**
 * Record a turn and its items into evidence tables.
 *
 * @param {object} db Database handle (run, get, all)
 * @param {object} turnData Turn payload
 * @param {object} [options]
 * @param {boolean} [options.isRuntime=false] Authorization token/flag (AC-EV-01-05)
 * @returns {object} Recording result
 */
export async function recordTurn(db, turnData, { isRuntime = false } = {}) {
    // AC-EV-01-05: RBAC - Only runtime can directly write to evidence tables
    if (!isRuntime) {
        const err = new Error('DIRECT_WRITE_FORBIDDEN: Only authorized runtime can directly write to evidence tables');
        err.code = 'DIRECT_WRITE_FORBIDDEN';
        throw err;
    }

    const {
        project,
        turn_id,
        at = new Date().toISOString(),
        actor_role = 'agent',
        actor_status = 'FULL',
        level = 'sufficient',
        mode = 'do',
        basis = 'verified',
        rule_version = '1.0.0',
        resolved = [], // Resolved[] elections
        files_used = [], // FileUse items
        items = [], // additional evidence_items
        payload = {},
    } = turnData || {};

    if (!project || !turn_id) {
        throw new Error('project and turn_id are required');
    }

    // Constraint validations
    if (!CLOSED_LEVELS.includes(level)) {
        throw new Error(`Invalid level: ${level}. Must be one of: ${CLOSED_LEVELS.join(', ')}`);
    }
    if (!CLOSED_MODES.includes(mode)) {
        throw new Error(`Invalid mode: ${mode}. Must be one of: ${CLOSED_MODES.join(', ')}`);
    }
    if (!CLOSED_BASES.includes(basis)) {
        throw new Error(`Invalid basis: ${basis}. Must be one of: ${CLOSED_BASES.join(', ')}`);
    }
    if (!CLOSED_ACTOR_STATUSES.includes(actor_status)) {
        throw new Error(`Invalid actor_status: ${actor_status}. Must be one of: ${CLOSED_ACTOR_STATUSES.join(', ')}`);
    }

    // AC-EV-01-06: Idempotent submission: check if (project, turn_id) already exists
    const existing = await db.get(
        `SELECT project, turn_id FROM evidence_turn WHERE project = ? AND turn_id = ?`,
        [project, turn_id]
    );

    if (existing) {
        // Already recorded; idempotent return without duplicating
        return {
            ok: true,
            idempotentReplay: true,
            project,
            turn_id,
        };
    }

    // Process files_used (AC-EV-01-01 & AC-EV-01-03)
    const normalizedFiles = files_used.map((file) => {
        const isDirty = Boolean(file.dirty || !file.commit);
        return {
            path: (file.path || '').replace(/\\/g, '/'),
            content_hash: file.content_hash || file.hash || 'hash_missing',
            git_commit: file.git_commit || file.commit || (isDirty ? null : 'clean'),
            dirty: isDirty,
            note: isDirty ? 'nội dung không lấy lại được (unreproducible content)' : null,
        };
    });

    const fullPayload = {
        ...payload,
        files_used: normalizedFiles,
        guarantee: payload.guarantee || 'evidence-backed',
        skill_versions: payload.skill_versions || {},
    };

    // Insert evidence_turn
    await db.run(
        `INSERT INTO evidence_turn (
            project, turn_id, at, actor_role, actor_status,
            level, mode, basis, rule_version, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            project,
            turn_id,
            at,
            actor_role,
            actor_status,
            level,
            mode,
            basis,
            rule_version,
            JSON.stringify(fullPayload),
        ]
    );

    let seqCounter = 1;

    // AC-EV-01-01: Insert Resolved[] as evidence_item with kind='election'
    for (const elect of resolved) {
        await db.run(
            `INSERT INTO evidence_item (project, turn_id, seq, kind, payload)
             VALUES (?, ?, ?, 'election', ?)`,
            [project, turn_id, seqCounter++, JSON.stringify(elect)]
        );
    }

    // Insert remaining evidence_items
    for (const item of items) {
        const kind = item.kind || 'claim';
        if (!CLOSED_ITEM_KINDS.includes(kind)) {
            throw new Error(`Invalid item kind: ${kind}`);
        }
        await db.run(
            `INSERT INTO evidence_item (project, turn_id, seq, kind, payload)
             VALUES (?, ?, ?, ?, ?)`,
            [project, turn_id, seqCounter++, kind, JSON.stringify(item.payload || item)]
        );
    }

    return {
        ok: true,
        project,
        turn_id,
        itemsCount: seqCounter - 1,
    };
}

/**
 * Read turn and its evidence items, checking for missing/deleted files.
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {string} params.turn_id Turn identifier
 * @param {function} [params.fsExists] Optional filesystem check: (path) => boolean
 * @returns {object|null} Turn record with Resolved[] and files_used with gone flags
 */
export async function readTurn(db, { project, turn_id, fsExists = null } = {}) {
    if (!project || !turn_id) {
        throw new Error('project and turn_id are required');
    }

    // AC-EV-01-04: Tenant isolation: query by project
    const row = await db.get(
        `SELECT project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload
         FROM evidence_turn
         WHERE project = ? AND turn_id = ?`,
        [project, turn_id]
    );

    if (!row) {
        return null;
    }

    const payload = JSON.parse(row.payload || '{}');

    // Read associated items
    const itemRows = await db.all(
        `SELECT seq, kind, payload
         FROM evidence_item
         WHERE project = ? AND turn_id = ?
         ORDER BY seq ASC`,
        [project, turn_id]
    );

    const items = itemRows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        payload: JSON.parse(r.payload || '{}'),
    }));

    const resolved = items
        .filter((i) => i.kind === 'election')
        .map((i) => i.payload);

    // AC-EV-01-07 / ED10: Check FileUse for deleted files
    const filesUsed = (payload.files_used || []).map((file) => {
        let isGone = false;
        if (typeof fsExists === 'function') {
            isGone = !fsExists(file.path);
        }
        return {
            ...file,
            gone: isGone,
        };
    });

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
        resolved,
        files_used: filesUsed,
        items,
        payload: {
            ...payload,
            files_used: filesUsed,
        },
    };
}
