/**
 * @mu/eso-learn — Proposal Review, Listing & Rejection (US-LEARN-02 / ESO-155 / Slice S1)
 *
 * Implements:
 * - AC-LEARN-02-01: List items have evidence (risk_id[]), expected_effect, revert
 * - AC-LEARN-02-02: Proposal without attached risks omitted or marked OUT with NO_EVIDENCE
 * - AC-LEARN-02-03: Applied proposal surfaces measure_window + measuring/concluded
 * - AC-LEARN-02-04: 0 proposals (ED1) yields clean empty list without error
 * - AC-LEARN-02-05: 500 proposals (ED3) supports pagination (page, pageSize, total, items)
 * - AC-LEARN-02-06: Rejection without reason rejected with NO_REASON; status remains proposed
 */

export function listProposals({
    proposals = [],
    project,
    page = 1,
    pageSize = 20,
    now = new Date().toISOString(),
    includeInvalid = false,
} = {}) {
    if (!Array.isArray(proposals)) {
        return { items: [], total: 0, page: 1, pageSize, totalPages: 0 };
    }

    // Filter by project if specified
    const projectFiltered = project
        ? proposals.filter((p) => p.project === project)
        : proposals;

    const processed = [];

    for (const p of projectFiltered) {
        // Parse evidence if it was serialized
        let evidence = p.evidence;
        if (typeof evidence === 'string') {
            try {
                evidence = JSON.parse(evidence);
            } catch {
                evidence = [];
            }
        }

        // AC-LEARN-02-02: Check for missing evidence
        const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
        if (!hasEvidence) {
            if (includeInvalid) {
                processed.push({
                    ...p,
                    evidence: [],
                    display_status: 'OUT',
                    out_reason: 'NO_EVIDENCE',
                });
            }
            continue;
        }

        const item = {
            ...p,
            evidence,
        };

        // AC-LEARN-02-03: Applied proposal measurement state
        if (p.status === 'applied') {
            let window = p.measure_window;
            if (typeof window === 'string') {
                try {
                    window = JSON.parse(window);
                } catch {
                    window = null;
                }
            }

            let measurementState = 'measuring';
            if (window) {
                if (window.to && new Date(now).getTime() >= new Date(window.to).getTime()) {
                    measurementState = 'concluded';
                } else if (window.concluded) {
                    measurementState = 'concluded';
                }
            }

            item.measure_window = window;
            item.measurement_state = measurementState;
        }

        processed.push(item);
    }

    const total = processed.length;
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, parseInt(pageSize, 10) || 20);
    const totalPages = Math.ceil(total / safePageSize);
    const offset = (safePage - 1) * safePageSize;
    const items = processed.slice(offset, offset + safePageSize);

    return {
        items,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
    };
}

export function rejectProposal({
    proposal,
    reason,
    actor = 'operator',
} = {}) {
    if (!proposal || typeof proposal !== 'object') {
        const err = new Error('Proposal is required');
        err.code = 'INVALID_PROPOSAL';
        throw err;
    }

    // AC-LEARN-02-06: Reject without reason
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
        const err = new Error('NO_REASON: Rejection requires an explicit reason (từ chối phải kèm lý do; đề xuất giữ proposed)');
        err.code = 'NO_REASON';
        throw err;
    }

    if (proposal.status !== 'proposed') {
        const err = new Error(`INVALID_STATE: Cannot reject proposal in status '${proposal.status}'`);
        err.code = 'INVALID_STATE';
        throw err;
    }

    return {
        ...proposal,
        status: 'rejected',
        rejection_reason: reason.trim(),
        rejected_by: actor,
        rejected_at: new Date().toISOString(),
    };
}
