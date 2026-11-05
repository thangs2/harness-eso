/**
 * @mu/eso-evidence — Risk Lifecycle Implementation (ESO-75 / US-EV-04 / Slice S1)
 *
 * Invariants & ACs:
 * - BR-06: Append-only evidence_risk. Sửa/xóa trực tiếp bị từ chối với APPEND_ONLY (AC-EV-04-02).
 * - AC-EV-04-01: Happy path: Đóng risk thêm sự kiện 'closed' + lý do + người; sự kiện 'opened' vẫn còn.
 * - AC-EV-04-03: Risk đã đóng KHÔNG được tính vào danh sách active / cụm đề xuất.
 * - AC-EV-04-04 / ED6: Đóng risk 2 lần -> ném ALREADY_CLOSED, KHÔNG thêm sự kiện thứ hai.
 * - AC-EV-04-05 / ED7: Race condition: thắng theo thứ tự sự kiện; risk đã đóng không vào cụm.
 */

/**
 * Open a new risk entry.
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {string} params.risk_id Risk identifier
 * @param {string} params.actor User/agent identifier
 * @param {object} [params.payload] Metadata payload
 * @param {string} [params.at] Timestamp
 * @returns {object} Open risk event summary
 */
export async function openRisk(db, {
    project,
    risk_id,
    actor,
    payload = {},
    at = new Date().toISOString(),
} = {}) {
    if (!project || !risk_id) {
        throw new Error('project and risk_id are required');
    }

    const normProject = project.trim();
    const normRiskId = risk_id.trim();

    // Check if risk already has an open event
    const existing = await db.get(
        `SELECT seq, event FROM evidence_risk WHERE project = ? AND risk_id = ? AND seq = 1`,
        [normProject, normRiskId]
    );

    if (existing) {
        return {
            ok: true,
            project: normProject,
            risk_id: normRiskId,
            seq: existing.seq,
            event: existing.event,
            idempotent: true,
        };
    }

    await db.run(
        `INSERT INTO evidence_risk (project, risk_id, seq, at, event, actor, payload)
         VALUES (?, ?, 1, ?, 'opened', ?, ?)`,
        [normProject, normRiskId, at, actor || 'system', JSON.stringify(payload)]
    );

    return {
        ok: true,
        project: normProject,
        risk_id: normRiskId,
        seq: 1,
        event: 'opened',
    };
}

/**
 * Close an active risk with reason and actor (AC-EV-04-01, AC-EV-04-04).
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {string} params.risk_id Risk identifier
 * @param {string} params.actor User closing the risk
 * @param {string} params.reason Mandatory closure reason
 * @param {object} [params.payload] Additional metadata
 * @param {string} [params.at] Timestamp
 * @returns {object} Close event summary
 */
export async function closeRisk(db, {
    project,
    risk_id,
    actor,
    reason,
    payload = {},
    at = new Date().toISOString(),
} = {}) {
    if (!project || !risk_id) {
        throw new Error('project and risk_id are required');
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new Error('Closure reason is required (AC-EV-04-01)');
    }
    if (!actor || typeof actor !== 'string' || !actor.trim()) {
        throw new Error('Closure actor is required (AC-EV-04-01)');
    }

    const normProject = project.trim();
    const normRiskId = risk_id.trim();

    // Fetch latest event for this risk
    const latest = await db.get(
        `SELECT seq, event
         FROM evidence_risk
         WHERE project = ? AND risk_id = ?
         ORDER BY seq DESC
         LIMIT 1`,
        [normProject, normRiskId]
    );

    if (!latest) {
        const err = new Error(`RISK_NOT_FOUND: Risk ${normRiskId} does not exist in project ${normProject}`);
        err.code = 'RISK_NOT_FOUND';
        throw err;
    }

    // AC-EV-04-04: If already closed, reject with ALREADY_CLOSED and do not add second event
    if (latest.event === 'closed' || latest.event === 'close') {
        const err = new Error(`ALREADY_CLOSED: Risk ${normRiskId} is already closed at seq ${latest.seq}`);
        err.code = 'ALREADY_CLOSED';
        throw err;
    }

    const nextSeq = latest.seq + 1;
    const closurePayload = {
        ...payload,
        reason: reason.trim(),
        by: actor.trim(),
    };

    await db.run(
        `INSERT INTO evidence_risk (project, risk_id, seq, at, event, actor, payload)
         VALUES (?, ?, ?, ?, 'closed', ?, ?)`,
        [normProject, normRiskId, nextSeq, at, actor.trim(), JSON.stringify(closurePayload)]
    );

    return {
        ok: true,
        project: normProject,
        risk_id: normRiskId,
        seq: nextSeq,
        event: 'closed',
        reason: reason.trim(),
        by: actor.trim(),
    };
}

/**
 * Retrieve the full event timeline of a risk.
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {string} params.risk_id Risk identifier
 * @returns {Array<object>} History of events
 */
export async function getRiskHistory(db, { project, risk_id } = {}) {
    const rows = await db.all(
        `SELECT project, risk_id, seq, at, event, actor, payload
         FROM evidence_risk
         WHERE project = ? AND risk_id = ?
         ORDER BY seq ASC`,
        [project, risk_id]
    );

    return rows.map((r) => ({
        project: r.project,
        risk_id: r.risk_id,
        seq: r.seq,
        at: r.at,
        event: r.event,
        actor: r.actor,
        payload: JSON.parse(r.payload || '{}'),
    }));
}

/**
 * List active risks for proposal clustering (AC-EV-04-03 & AC-EV-04-05).
 * Risks whose latest state is 'closed' or 'close' are strictly excluded.
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @returns {Array<object>} List of active risks
 */
export async function listActiveRisks(db, { project } = {}) {
    if (!project) throw new Error('project is required');

    // Subquery getting the latest event for each risk in this project
    const rows = await db.all(
        `SELECT r.project, r.risk_id, r.seq, r.at, r.event, r.actor, r.payload
         FROM evidence_risk r
         INNER JOIN (
             SELECT project, risk_id, MAX(seq) AS max_seq
             FROM evidence_risk
             WHERE project = ?
             GROUP BY project, risk_id
         ) latest ON r.project = latest.project AND r.risk_id = latest.risk_id AND r.seq = latest.max_seq
         WHERE r.event NOT IN ('closed', 'close')
         ORDER BY r.risk_id ASC`,
        [project]
    );

    return rows.map((r) => ({
        project: r.project,
        risk_id: r.risk_id,
        status: r.event,
        seq: r.seq,
        at: r.at,
        actor: r.actor,
        payload: JSON.parse(r.payload || '{}'),
    }));
}
