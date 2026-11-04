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

export function electCapabilityProvider({
    project,
    turnId,
    capabilityKind,
    host = 'cursor',
    branches = {},
    pins = {},
    actorRole = 'operator',
    existingElections = [],
    turnAuditLog = [],
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

    // Check for pinning (US-HOST-04)
    const pin = pins[capabilityKind];
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
    };
}

export function setCapabilityPin({
    capabilityKind,
    targetBranch,
    actorRole = 'operator',
    currentPins = {},
} = {}) {
    // AC-HOST-04-02 / RBAC: Agent prohibited from mutating pin
    if (actorRole !== 'operator' && actorRole !== 'admin') {
        const err = new Error(`FORBIDDEN_MUTATION: Agent role '${actorRole}' is prohibited from modifying capability pins`);
        err.code = 'FORBIDDEN_MUTATION';
        err.role = actorRole;
        throw err;
    }

    // AC-HOST-04-05 / ED1: Empty pin removes pinning
    if (!targetBranch || targetBranch.trim() === '') {
        const updated = { ...currentPins };
        delete updated[capabilityKind];
        return updated;
    }

    return {
        ...currentPins,
        [capabilityKind]: targetBranch.trim(),
    };
}

export function queryTurnProviderAudit({
    turnId,
    auditLog = [],
} = {}) {
    if (!turnId) throw new Error('turnId is required');

    // AC-HOST-05-04 / ED1: Turn with 0 capabilities
    const records = auditLog.filter((r) => r.turn_id === turnId);
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

export function queryBatchProviderAudit({
    turnIds = [],
    auditLog = [],
} = {}) {
    // AC-HOST-05-05 / ED3: 200 turns query is stably sorted
    const idSet = new Set(turnIds);
    const matched = auditLog.filter((r) => idSet.has(r.turn_id));

    // Sort deterministically by turn_id, then capability
    matched.sort((a, b) => {
        if (a.turn_id !== b.turn_id) return a.turn_id.localeCompare(b.turn_id);
        return a.capability.localeCompare(b.capability);
    });

    return matched;
}
