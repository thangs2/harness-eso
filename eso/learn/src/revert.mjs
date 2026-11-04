/**
 * @mu/eso-learn — Proposal Single-Action Reversion (US-LEARN-05 / ESO-170 / Slice S1)
 *
 * Implements:
 * - AC-LEARN-05-01: Single-action reversion of applied proposal to previous version, status: reverted
 * - AC-LEARN-05-02: Reverting proposed item rejected with NOT_APPLIED (0 changes)
 * - AC-LEARN-05-03: Measurement window is closed, measurement halted, no new conclusions
 * - AC-LEARN-05-04: Agent actor attempting to revert rejected with APPLY_FORBIDDEN (0 changes)
 * - AC-LEARN-05-05: ED6 — Already reverted proposal rejected with NOT_APPLIED (0 changes)
 * - AC-LEARN-05-06: ED8 — Reversion after window closure preserves prior evaluation conclusions
 * - AC-LEARN-05-07: Version decrements by exactly one; proposal record is preserved (never deleted)
 */

export function decrementVersion(v) {
    if (typeof v === 'number') {
        return Math.max(1, v - 1);
    }
    if (typeof v === 'string') {
        const parts = v.split('.');
        const lastIndex = parts.length - 1;
        const lastNum = parseInt(parts[lastIndex], 10);
        if (!isNaN(lastNum)) {
            parts[lastIndex] = String(Math.max(0, lastNum - 1));
            return parts.join('.');
        }
    }
    return v;
}

export function revertProposal({
    proposal,
    actor = 'operator',
    now = new Date().toISOString(),
    reason = 'Operator single-action rollback',
} = {}) {
    if (!proposal || typeof proposal !== 'object') {
        const err = new Error('Proposal is required');
        err.code = 'INVALID_PROPOSAL';
        throw err;
    }

    // AC-LEARN-05-04: RBAC enforcement
    const isAuthorized = actor === 'operator' || actor === 'human' || actor === 'A-01';
    if (!isAuthorized) {
        const err = new Error(`APPLY_FORBIDDEN: Actor '${actor}' is not authorized to revert proposals (operator A-01 only)`);
        err.code = 'APPLY_FORBIDDEN';
        err.actor = actor;
        throw err;
    }

    // AC-LEARN-05-02 & AC-LEARN-05-05: Status must be 'applied'
    if (proposal.status !== 'applied') {
        const err = new Error(`NOT_APPLIED: Cannot revert proposal in status '${proposal.status}' (must be 'applied')`);
        err.code = 'NOT_APPLIED';
        err.status = proposal.status;
        throw err;
    }

    // AC-LEARN-05-07: Version decrements by exactly one
    const newVersion = decrementVersion(proposal.version);

    // AC-LEARN-05-03: Measurement window closed and halted
    const updatedWindow = proposal.measure_window
        ? {
            ...proposal.measure_window,
            closed_at: now,
            active: false,
        }
        : null;

    return {
        ...proposal,
        version: newVersion,
        status: 'reverted',
        reverted_at: now,
        reverted_by: actor,
        revert_reason: reason,
        measure_window: updatedWindow,
        measurement_state: 'halted',
        // AC-LEARN-05-06: prior evaluation preserved
        evaluation: proposal.evaluation || null,
    };
}
