/**
 * @mu/eso-adapters — Capability Provider Election & Host Adaptation
 *
 * Covers:
 * - US-HOST-01 (ESO-228): Branch election order (host-native -> eso-native -> external -> none),
 *   branch logging with reason, unknown host rejection, tenant isolation.
 * - US-HOST-02 (ESO-300): Fallback to none, degraded guarantee, task continues, multi-capability support.
 * - US-HOST-03 (ESO-233): Mid-turn branch change logging, trial history, dangling provider detection.
 * - US-HOST-04 (ESO-238): Capability pinning, strict PIN_UNAVAILABLE enforcement, RBAC protection.
 * - US-HOST-05 (ESO-222): Turn provider audit trail, branch history, degraded notice, stable batch query.
 */

export const BRANCH_ORDER = Object.freeze(['host-native', 'eso-native', 'external', 'none']);

export const KNOWN_HOSTS = Object.freeze(['cursor', 'antigravity', 'deepseek-harness']);

export const ERROR_SILENT_SWITCH = 'SILENT_SWITCH';
export const ERROR_SILENT_NONE = 'SILENT_NONE';

export async function electCapabilityProvider({
    project,
    turnId,
    capabilityKind,
    host = 'cursor',
    branches = {},
    pins = {},
    actorRole = 'operator',
    existingElections = [],
    turnAuditLog = [],
    db = null,
} = {}) {
    if (!project) throw new Error('Project is required');
    if (!turnId) throw new Error('turnId is required');
    if (!capabilityKind) throw new Error('capabilityKind is required');

    // AC-HOST-01-08: Host not declared in matrix
    if (!KNOWN_HOSTS.includes(host)) {
        const err = new Error(`HOST_NOT_DECLARED: Host '${host}' is not declared in capability matrix`);
        err.code = 'HOST_NOT_DECLARED';
        err.host = host;
        throw err;
    }

    // AC-HOST-02-05 / ED6: Idempotency within turn for same capabilityKind
    const existing = existingElections.find(
        (e) => e.turn_id === turnId && e.project === project && e.capability === capabilityKind
    );
    if (existing) {
        return existing;
    }

    // Check for pinning (US-HOST-04 & ESO-382: read from capability_pin store if present)
    let effectivePins = { ...pins };
    if (db) {
        // D-93: PostgreSQL catalog lookup; a missing table means no pin store yet.
        const pinTable = await db.get(`SELECT to_regclass('capability_pin') AS oid`);
        if (pinTable && pinTable.oid) {
            const row = await db.get(
                `SELECT pinned_branch FROM capability_pin WHERE project = ? AND capability_kind = ?`,
                [project, capabilityKind]
            );
            if (row && row.pinned_branch) {
                effectivePins[capabilityKind] = row.pinned_branch;
            }
        }
    }

    const pin = effectivePins[capabilityKind];
    if (pin && typeof pin === 'string' && pin.trim() !== '') {
        // AC-HOST-04-03 & AC-HOST-04-04 / ED4: Pin unavailable or OUT
        const branchAvailability = branches[pin];
        if (!branchAvailability || branchAvailability.available === false || branchAvailability.status === 'OUT') {
            const err = new Error(
                `PIN_UNAVAILABLE: Pinned branch '${pin}' for capability '${capabilityKind}' is unavailable or marked OUT on host '${host}'`
            );
            err.code = 'PIN_UNAVAILABLE';
            err.capability = capabilityKind;
            err.pinned_branch = pin;
            throw err;
        }

        // AC-HOST-04-01: Pinned branch elected directly (skipping earlier branches)
        const election = {
            project,
            turn_id: turnId,
            capability: capabilityKind,
            branch: pin,
            provider_id: branchAvailability.provider_id || `${host}-${pin}`,
            pinned: true,
            reason: `Pinned explicitly to branch '${pin}'`,
            guarantee: 'G-FULL',
            history: [{ branch: pin, status: 'elected', at: new Date().toISOString() }],
        };
        turnAuditLog.push(election);
        return election;
    }

    // AC-HOST-01-04: Test branches in exact order: host-native -> eso-native -> external -> none
    const trialHistory = [];

    for (const branch of BRANCH_ORDER) {
        if (branch === 'none') {
            // AC-HOST-01-02 & AC-HOST-02-01: No branches available -> elect none
            // Guarantee degraded, reason stated, task continues
            trialHistory.push({ branch: 'none', status: 'fallback', reason: 'all previous branches missing/unavailable' });
            const election = {
                project,
                turn_id: turnId,
                capability: capabilityKind,
                branch: 'none',
                provider_id: null,
                guarantee: 'G-DEGRADED',
                level: 'degraded',
                reason: `Năng lực '${capabilityKind}' không có trên host '${host}'; hạ mức bảo đảm sang G-DEGRADED`,
                history: trialHistory,
            };
            turnAuditLog.push(election);
            return election;
        }

        const candidate = branches[branch];
        if (candidate && candidate.available === true && candidate.status !== 'OUT') {
            // AC-HOST-01-01: Branch available
            trialHistory.push({ branch, status: 'elected', provider_id: candidate.provider_id });
            const election = {
                project,
                turn_id: turnId,
                capability: capabilityKind,
                branch,
                provider_id: candidate.provider_id || `${host}-${branch}`,
                guarantee: 'G-FULL',
                reason: `Được chọn theo thứ tự ưu tiên: nhánh '${branch}'`,
                history: trialHistory,
            };
            turnAuditLog.push(election);
            return election;
        } else {
            // Branch tested and found absent/unavailable (AC-HOST-01-06 / ED1)
            trialHistory.push({
                branch,
                status: 'skipped',
                reason: candidate ? candidate.reason || 'candidate marked OUT' : 'branch unavailable',
            });
        }
    }
}

export function handleMidTurnBranchFailure({
    currentElection,
    failureReason,
    branches = {},
    uninstalledProviders = [],
    silent = false,
    silentNone = false,
} = {}) {
    if (!currentElection) throw new Error('currentElection is required');

    // AC-HOST-03-05 / ED10: Replaying record where provider was uninstalled
    if (uninstalledProviders.includes(currentElection.provider_id)) {
        return {
            ...currentElection,
            status: 'DANGLING_PROVIDER',
            is_active: false,
            message: `nguồn đã mất: provider '${currentElection.provider_id}' đã bị gỡ`,
        };
    }

    // ESO-383 / B5: Silent switch is strictly forbidden
    if (silent || !failureReason || typeof failureReason !== 'string' || failureReason.trim() === '') {
        const err = new Error('SILENT_SWITCH: Mid-turn branch switch cannot be silent; explicit failure reason is required');
        err.code = ERROR_SILENT_SWITCH;
        throw err;
    }

    const currentBranch = currentElection.branch;
    const currentIndex = BRANCH_ORDER.indexOf(currentBranch);

    const updatedHistory = [
        ...(currentElection.history || []),
        {
            branch: currentBranch,
            status: 'failed',
            reason: failureReason,
            failed_at: new Date().toISOString(),
        },
    ];

    // Find next viable branch in remaining order
    let nextBranch = 'none';
    let nextProvider = null;
    let nextGuarantee = 'G-DEGRADED';
    let nextReason = `Nhánh '${currentBranch}' gặp lỗi (${failureReason}); hạ xuống none`;

    for (let i = currentIndex + 1; i < BRANCH_ORDER.length; i++) {
        const candidateBranch = BRANCH_ORDER[i];
        if (candidateBranch === 'none') {
            nextBranch = 'none';
            break;
        }

        const candidate = branches[candidateBranch];
        if (candidate && candidate.available === true && !candidate.failed) {
            nextBranch = candidateBranch;
            nextProvider = candidate.provider_id || candidateBranch;
            nextGuarantee = 'G-FULL';
            nextReason = `Đổi từ nhánh '${currentBranch}' sang '${candidateBranch}' do lỗi: ${failureReason}`;
            break;
        } else {
            // AC-HOST-03-04 / ED6: Intermediate candidate also failed immediately
            updatedHistory.push({
                branch: candidateBranch,
                status: 'failed_immediately',
                reason: candidate ? candidate.reason || 'failed on test' : 'unavailable',
            });
        }
    }

    // ESO-383 / B5: Silent fallback to none is strictly forbidden
    if (nextBranch === 'none' && (silentNone || !failureReason || failureReason.trim() === '')) {
        const err = new Error('SILENT_NONE: Falling back to none on zero-source path without reason or silently is prohibited');
        err.code = ERROR_SILENT_NONE;
        throw err;
    }

    updatedHistory.push({
        branch: nextBranch,
        status: 'switched',
        at: new Date().toISOString(),
    });

    // AC-HOST-03-01 & AC-HOST-03-03: Surfaces both tried branches and active branch
    return {
        ...currentElection,
        branch: nextBranch,
        provider_id: nextProvider,
        guarantee: nextGuarantee,
        previous_branch: currentBranch,
        reason: nextReason,
        history: updatedHistory,
        switched: true,
        switch_record: {
            from: currentBranch,
            to: nextBranch,
            reason: failureReason,
            at: new Date().toISOString(),
            silent: false,
        },
    };
}

export async function setCapabilityPin({
    project = 'default',
    capabilityKind,
    targetBranch,
    actorRole = 'operator',
    currentPins = {},
    db = null,
} = {}) {
    // AC-HOST-04-02 / RBAC: Agent prohibited from mutating pin
    if (actorRole !== 'operator' && actorRole !== 'admin') {
        const err = new Error(`FORBIDDEN_MUTATION: Agent role '${actorRole}' is prohibited from modifying capability pins`);
        err.code = 'FORBIDDEN_MUTATION';
        err.role = actorRole;
        throw err;
    }

    if (db) {
        const ensureTableSql = `
            CREATE TABLE IF NOT EXISTS capability_pin (
                project         TEXT NOT NULL,
                capability_kind TEXT NOT NULL,
                pinned_branch   TEXT NOT NULL,
                updated_at      TEXT NOT NULL,
                PRIMARY KEY (project, capability_kind)
            );
        `;
        await db.exec(ensureTableSql);
    }

    // AC-HOST-04-05 / ED1: Empty pin removes pinning
    if (!targetBranch || targetBranch.trim() === '') {
        const updated = { ...currentPins };
        delete updated[capabilityKind];
        if (db) {
            const delSql = `DELETE FROM capability_pin WHERE project = ? AND capability_kind = ?`;
            await db.run(delSql, [project, capabilityKind]);
        }
        return updated;
    }

    const branch = targetBranch.trim();
    if (db) {
        const insertSql = `
            INSERT INTO capability_pin (project, capability_kind, pinned_branch, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project, capability_kind) DO UPDATE SET
                pinned_branch = excluded.pinned_branch,
                updated_at = excluded.updated_at
        `;
        const now = new Date().toISOString();
        await db.run(insertSql, [project, capabilityKind, branch, now]);
    }

    return {
        ...currentPins,
        [capabilityKind]: branch,
    };
}

export async function loadCapabilityPins({
    project = 'default',
    db = null,
} = {}) {
    if (!db) return {};

    const pinTable = await db.get(`SELECT to_regclass('capability_pin') AS oid`);
    if (!pinTable || !pinTable.oid) return {};

    const rows = await db.all(
        `SELECT capability_kind, pinned_branch FROM capability_pin WHERE project = ?`,
        [project]
    );

    const pins = {};
    for (const r of rows) {
        pins[r.capability_kind] = r.pinned_branch;
    }
    return pins;
}

export async function recordTurnProviderAudit({
    project = 'default',
    turnId,
    election,
    db = null,
    auditLog = null,
} = {}) {
    if (!turnId) throw new Error('turnId is required');
    if (!election) throw new Error('election is required');

    const record = {
        project,
        turn_id: turnId,
        capability: election.capability,
        branch: election.branch,
        provider_id: election.provider_id,
        guarantee: election.guarantee || 'G-FULL',
        pinned: election.pinned ? 1 : 0,
        reason: election.reason || '',
        history: election.history || [],
        recorded_at: new Date().toISOString(),
    };

    if (db) {
        const ensureSql = `
            CREATE TABLE IF NOT EXISTS provider_audit (
                project     TEXT NOT NULL,
                turn_id     TEXT NOT NULL,
                capability  TEXT NOT NULL,
                branch      TEXT NOT NULL,
                provider_id TEXT,
                guarantee   TEXT NOT NULL,
                pinned      INTEGER NOT NULL DEFAULT 0,
                reason      TEXT,
                history     TEXT NOT NULL DEFAULT '[]',
                recorded_at TEXT NOT NULL,
                PRIMARY KEY (project, turn_id, capability)
            );
        `;
        await db.exec(ensureSql);

        const insertSql = `
            INSERT INTO provider_audit (project, turn_id, capability, branch, provider_id, guarantee, pinned, reason, history, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project, turn_id, capability) DO UPDATE SET
                branch = excluded.branch,
                provider_id = excluded.provider_id,
                guarantee = excluded.guarantee,
                pinned = excluded.pinned,
                reason = excluded.reason,
                history = excluded.history,
                recorded_at = excluded.recorded_at
        `;
        const params = [
            project,
            turnId,
            record.capability,
            record.branch,
            record.provider_id,
            record.guarantee,
            record.pinned,
            record.reason,
            JSON.stringify(record.history),
            record.recorded_at,
        ];
        await db.run(insertSql, params);
    }

    if (Array.isArray(auditLog)) {
        auditLog.push(record);
    }

    return record;
}

export async function queryTurnProviderAudit({
    turnId,
    project = 'default',
    db = null,
    auditLog = [],
} = {}) {
    if (!turnId) throw new Error('turnId is required');

    let records = [];
    if (db) {
        // ESO-382: read the canonical evidence_item rows (kind='election'). The canonical schema has
        // no per-item timestamp, so the turn row supplies `recorded_at` when the payload has no `at`.
        const hasEvItem = await db.get(`SELECT to_regclass('evidence_item') AS oid`);
        if (hasEvItem && hasEvItem.oid) {
            const evRows = await db.all(
                `SELECT payload FROM evidence_item WHERE project = ? AND turn_id = ? AND kind = 'election' ORDER BY seq ASC`,
                [project, turnId]
            );
            const turnRow = await db.get(
                `SELECT at FROM evidence_turn WHERE project = ? AND turn_id = ?`,
                [project, turnId]
            );
            const turnAt = turnRow ? turnRow.at : null;

            for (const r of evRows) {
                const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
                records.push({
                    project,
                    turn_id: turnId,
                    capability: p.capability || p.capabilityKind,
                    branch: p.branch,
                    provider_id: p.provider_id || p.providerId,
                    guarantee: p.guarantee,
                    pinned: !!p.pinned,
                    reason: p.reason,
                    history: p.history || [],
                    recorded_at: p.at || turnAt || null,
                });
            }
        }

        if (records.length === 0) {
            const auditTable = await db.get(`SELECT to_regclass('provider_audit') AS oid`);
            if (auditTable && auditTable.oid) {
                const rows = await db.all(
                    `SELECT * FROM provider_audit WHERE project = ? AND turn_id = ?`,
                    [project, turnId]
                );

                records = rows.map((r) => ({
                    project: r.project,
                    turn_id: r.turn_id,
                    capability: r.capability,
                    branch: r.branch,
                    provider_id: r.provider_id,
                    guarantee: r.guarantee,
                    pinned: !!r.pinned,
                    reason: r.reason,
                    history: JSON.parse(r.history || '[]'),
                    recorded_at: r.recorded_at,
                }));
            }
        }
    }

    if (records.length === 0 && Array.isArray(auditLog)) {
        records = auditLog.filter((r) => r.turn_id === turnId);
    }

    if (records.length === 0) {
        return {
            turn_id: turnId,
            records: [],
            message: 'turn không dùng năng lực nào',
        };
    }

    return {
        turn_id: turnId,
        records,
        has_degraded: records.some((r) => r.branch === 'none' || r.guarantee === 'G-DEGRADED'),
    };
}

export async function queryBatchProviderAudit({
    turnIds = [],
    project = 'default',
    db = null,
    auditLog = [],
} = {}) {
    let records = [];
    if (db) {
        const auditTable = await db.get(`SELECT to_regclass('provider_audit') AS oid`);
        if (auditTable && auditTable.oid && turnIds.length > 0) {
            const placeholders = turnIds.map(() => '?').join(',');
            const sql = `SELECT * FROM provider_audit WHERE project = ? AND turn_id IN (${placeholders})`;
            const rows = await db.all(sql, [project, ...turnIds]);

            records = rows.map((r) => ({
                project: r.project,
                turn_id: r.turn_id,
                capability: r.capability,
                branch: r.branch,
                provider_id: r.provider_id,
                guarantee: r.guarantee,
                pinned: !!r.pinned,
                reason: r.reason,
                history: JSON.parse(r.history || '[]'),
                recorded_at: r.recorded_at,
            }));
        }
    }

    if (records.length === 0 && Array.isArray(auditLog)) {
        const idSet = new Set(turnIds);
        records = auditLog.filter((r) => idSet.has(r.turn_id));
    }

    const matched = [...records];
    matched.sort((a, b) => {
        if (a.turn_id !== b.turn_id) return a.turn_id.localeCompare(b.turn_id);
        return a.capability.localeCompare(b.capability);
    });

    return matched;
}

export function invokeCapabilityProvider(election, fn) {
    if (!election || election.branch === 'none' || !election.provider_id) {
        const err = new Error(`SILENT_NONE: Cannot invoke capability '${election?.capability || 'unknown'}' on zero-source path`);
        err.code = ERROR_SILENT_NONE;
        throw err;
    }
    if (typeof fn === 'function') {
        return fn(election);
    }
    return election;
}
