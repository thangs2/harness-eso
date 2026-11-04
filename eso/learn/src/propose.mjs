/**
 * @mu/eso-learn — Proposal Generation & RBAC Guard (US-LEARN-01 / ESO-150 / Slice S1)
 *
 * Implements:
 * - AC-LEARN-01-01: Propose with >=2 distinct risks of same kind, valid revert, expected_effect, status: proposed
 * - AC-LEARN-01-02: Missing or empty revert rejected with NO_REVERT (0 records created)
 * - AC-LEARN-01-03: Machine/agent applying proposal is rejected with APPLY_FORBIDDEN (operator A-01 only)
 * - AC-LEARN-01-04: Proposal carries measurable expected_effect
 * - AC-LEARN-01-05: 0 risks of same kind (ED1) rejected with NO_CLUSTER
 * - AC-LEARN-01-06: 1 risk repeated (ED6) distinct count < threshold rejected with NO_CLUSTER
 */

import crypto from 'node:crypto';

export function createProposal({
    project,
    risk_kind,
    risks = [],
    expected_effect,
    revert,
    threshold = 2,
    proposal_id,
} = {}) {
    if (!project) {
        const err = new Error('Project is required');
        err.code = 'INVALID_PROJECT';
        throw err;
    }

    if (!risk_kind) {
        const err = new Error('risk_kind is required');
        err.code = 'INVALID_RISK_KIND';
        throw err;
    }

    // Filter risks matching risk_kind
    const matchingRisks = risks.filter((r) => !r.risk_kind || r.risk_kind === risk_kind || r.kind === risk_kind);

    // ED1 & AC-LEARN-01-05: 0 risks of same kind
    if (matchingRisks.length === 0) {
        const err = new Error(`NO_CLUSTER: 0 risks found for kind '${risk_kind}' (chưa đủ cụm)`);
        err.code = 'NO_CLUSTER';
        throw err;
    }

    // ED6 & AC-LEARN-01-06: Count distinct risk/gap IDs
    const distinctRiskIds = new Set();
    const evidenceList = [];
    for (const r of matchingRisks) {
        const id = r.risk_id || r.gap_id || r.id;
        if (id) {
            distinctRiskIds.add(id);
            evidenceList.push(id);
        }
    }

    if (distinctRiskIds.size < threshold) {
        const err = new Error(`NO_CLUSTER: Only ${distinctRiskIds.size} distinct risk(s) found, minimum cluster threshold is ${threshold}`);
        err.code = 'NO_CLUSTER';
        err.distinct_count = distinctRiskIds.size;
        throw err;
    }

    // AC-LEARN-01-02: Revert check
    if (!revert || typeof revert !== 'object' || Object.keys(revert).length === 0) {
        const err = new Error('NO_REVERT: Revert strategy must be defined and non-empty (đề xuất không lùi được thì không được tạo)');
        err.code = 'NO_REVERT';
        throw err;
    }

    // AC-LEARN-01-04: Expected effect check
    if (!expected_effect || typeof expected_effect !== 'string' || expected_effect.trim() === '') {
        const err = new Error('INVALID_EXPECTED_EFFECT: expected_effect must describe measurable target metrics');
        err.code = 'INVALID_EXPECTED_EFFECT';
        throw err;
    }

    const id = proposal_id || crypto.randomUUID();

    const proposal = {
        project,
        proposal_id: id,
        version: 1,
        risk_kind,
        evidence: Array.from(distinctRiskIds),
        expected_effect,
        revert,
        status: 'proposed',
        applied_at: null,
        measure_window: null,
    };

    return proposal;
}

export function applyProposal({
    proposal,
    actor = 'operator',
    window = '30d',
} = {}) {
    if (!proposal || typeof proposal !== 'object') {
        const err = new Error('Proposal is required');
        err.code = 'INVALID_PROPOSAL';
        throw err;
    }

    // AC-LEARN-01-03: Machine / agent application forbidden
    const isHumanOperator = actor === 'operator' || actor === 'human' || actor === 'A-01';
    if (!isHumanOperator) {
        const err = new Error(`APPLY_FORBIDDEN: Actor '${actor}' is not authorized to apply proposals (operator A-01 only)`);
        err.code = 'APPLY_FORBIDDEN';
        err.actor = actor;
        throw err;
    }

    if (proposal.status === 'applied') {
        return proposal;
    }

    const now = new Date().toISOString();
    return {
        ...proposal,
        status: 'applied',
        applied_at: now,
        measure_window: {
            from: now,
            duration: window,
        },
    };
}
