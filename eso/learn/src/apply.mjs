/**
 * @mu/eso-learn — Proposal Application & Measurement Window (US-LEARN-03 / ESO-160 / Slice S1)
 *
 * Implements:
 * - AC-LEARN-03-01: Apply proposal bumps version, sets status 'applied', opens measure_from/measure_to window
 * - AC-LEARN-03-02: Machine/agent applying proposal rejected with APPLY_FORBIDDEN (0 changes)
 * - AC-LEARN-03-03: Applying already applied proposal rejected with ALREADY_APPLIED (single window)
 * - AC-LEARN-03-04: Measurement state immediately after apply is 'measuring', never effective: true
 * - AC-LEARN-03-05: ED8 — measure_from equals exact application timestamp (now)
 * - AC-LEARN-03-06: ED7 — Concurrent apply: 1 succeeds, other gets ALREADY_APPLIED
 * - AC-LEARN-03-07: Idempotent re-apply preserves version, hash, artifact unchanged
 */

export function parseWindowDuration(duration = '30d') {
    if (typeof duration === 'number') {
        return duration;
    }
    const match = String(duration).match(/^(\d+)([dhm])$/);
    if (!match) {
        return 30 * 24 * 60 * 60 * 1000;
    }
    const count = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 'd') return count * 24 * 60 * 60 * 1000;
    if (unit === 'h') return count * 60 * 60 * 1000;
    if (unit === 'm') return count * 60 * 1000;
    return 30 * 24 * 60 * 60 * 1000;
}

export function applyProposalToSystem({
    proposal,
    actor = 'operator',
    windowDuration = '30d',
    now,
    idempotent = false,
} = {}) {
    if (!proposal || typeof proposal !== 'object') {
        const err = new Error('Proposal object is required');
        err.code = 'INVALID_PROPOSAL';
        throw err;
    }

    // AC-LEARN-03-02: RBAC check
    const isAuthorized = actor === 'operator' || actor === 'human' || actor === 'A-01';
    if (!isAuthorized) {
        const err = new Error(`APPLY_FORBIDDEN: Actor '${actor}' is not authorized to apply proposals (operator A-01 only)`);
        err.code = 'APPLY_FORBIDDEN';
        err.actor = actor;
        throw err;
    }

    // AC-LEARN-03-03 & AC-LEARN-03-07: Already applied handling
    if (proposal.status === 'applied') {
        if (idempotent) {
            return {
                ...proposal,
                idempotent: true,
            };
        }
        const err = new Error(`ALREADY_APPLIED: Proposal '${proposal.proposal_id}' is already applied; exactly one measurement window allowed`);
        err.code = 'ALREADY_APPLIED';
        err.proposal_id = proposal.proposal_id;
        throw err;
    }

    // Check revert exists
    if (!proposal.revert || (typeof proposal.revert === 'object' && Object.keys(proposal.revert).length === 0)) {
        const err = new Error('NO_REVERT: Proposal must carry non-empty revert definition');
        err.code = 'NO_REVERT';
        throw err;
    }

    const startTime = now || new Date().toISOString();
    const durationMs = parseWindowDuration(windowDuration);
    const endTime = new Date(new Date(startTime).getTime() + durationMs).toISOString();

    const newVersion = (typeof proposal.version === 'number' ? proposal.version : 1) + 1;

    return {
        ...proposal,
        version: newVersion,
        status: 'applied',
        applied_at: startTime,
        measure_from: startTime,
        measure_to: endTime,
        measure_window: {
            from: startTime,
            to: endTime,
            duration: windowDuration,
        },
        // AC-LEARN-03-04: Cannot conclude effectiveness immediately
        effective: false,
        measurement_state: 'measuring',
    };
}
