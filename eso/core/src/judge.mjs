/**
 * @mu/eso-core — Sufficiency Judgement Function (ESO-95 / US-SUF-01 / Slice S1)
 *
 * Implements:
 * - 07.sufficiency.md §3 state machine
 * - AC-SUF-01-01: Per-requirement level and basis (no aggregate replaces them).
 * - AC-SUF-01-02: Untraceable requirement yields cannot-judge + reason in unknowns[], not absent (unknown != absent).
 * - AC-SUF-01-03: Finite, countable gaps list with what + where_hint (never omitted, defaults to "không rõ nguồn").
 * - AC-SUF-01-04: Host lacking required capability yields cannot-judge + named missing capability, assurance DEGRADED.
 * - AC-SUF-01-05: Verdict does NOT automatically change mode. Mode and selector are recorded separately.
 * - AC-SUF-01-06 (ED4): basis == min_basis is satisfied (sufficient if no other requirement is unsat).
 * - AC-SUF-01-07 (ED1): Empty requirements list yields cannot-judge + "không có gì để yêu cầu", never sufficient.
 * - AC-SUF-01-08: Rejects requirement missing source with SOURCE_MISSING error, 0 requirements loaded.
 *
 * Invariants:
 * - INV-ESO-01: Never conclude sufficient without basis.
 * - INV-ESO-02: cannot-judge never becomes permitted on its own (only ask/block/bypassed).
 * - INV-ESO-03: Every requirement must name its source (bar, work, blast, declared).
 * - D-63: gap_items sorted by source: bar < work < blast < declared.
 */

import {
    SOURCES,
    LEVELS,
    MODES,
    BASES,
    BASIS_WEIGHT,
    EXISTS,
    assertValidRequirement,
} from './types.mjs';

const SOURCE_ORDER = Object.freeze({
    bar: 1,
    work: 2,
    blast: 3,
    declared: 4,
});

/**
 * Min basis calculator over a list of basis strings.
 */
function minBasis(bases) {
    if (!bases || bases.length === 0) return 'inferred';
    let minW = Infinity;
    let minB = 'verified';
    for (const b of bases) {
        const w = BASIS_WEIGHT[b] || 1;
        if (w < minW) {
            minW = w;
            minB = b;
        }
    }
    return minB;
}

/**
 * Judges sufficiency from requirements, answers, and environmental context.
 *
 * @param {object} params
 * @param {Array} params.requirements List of Requirement objects
 * @param {Array|object|Map} [params.answers=[]] Answers for requirements
 * @param {object} [params.actor={}] Actor context
 * @param {object} [params.host={}] Host capabilities probe context
 * @param {string} [params.mode] Requested or assigned mode (do, ask, block, permitted, bypassed)
 * @param {string} [params.mode_selected_by] Actor or system component selecting the mode
 */
export function judgeSufficiency({
    requirements = [],
    answers = [],
    actor = {},
    host = {},
    graph = null,
    mode = null,
    mode_selected_by = null,
} = {}) {
    // AC-SUF-05-07: If graph is not built or missing, return cannot-judge with basis declared
    if (graph && (graph.built === false || graph.missing === true)) {
        const selectedMode = mode || 'ask';
        return {
            level: 'cannot-judge',
            basis: 'declared',
            cannot_judge_reason: 'missing_graph',
            mode: selectedMode === 'permitted' ? 'ask' : selectedMode,
            mode_selected_by: mode_selected_by || 'system',
            requirements: [],
            answers: [],
            sat: [],
            unsat: [],
            gaps: [],
            unknowns: [{ what: 'graph', reason: 'graph chưa dựng' }],
            ratio: '0/0',
            assurance: 'DEGRADED',
        };
    }

    // 1. Validate requirements (AC-SUF-01-08: fail fast on invalid/missing source)
    if (!Array.isArray(requirements)) {
        const err = new Error('SOURCE_MISSING: requirements must be an array');
        err.code = 'SOURCE_MISSING';
        throw err;
    }

    for (const r of requirements) {
        assertValidRequirement(r);
    }

    // Index answers
    const answersMap = new Map();
    if (Array.isArray(answers)) {
        for (const a of answers) {
            if (a && a.requirement) {
                answersMap.set(a.requirement, a);
            }
        }
    } else if (answers instanceof Map) {
        for (const [k, v] of answers.entries()) {
            answersMap.set(k, v);
        }
    } else if (answers && typeof answers === 'object') {
        for (const [k, v] of Object.entries(answers)) {
            answersMap.set(k, v);
        }
    }

    const missingHostCaps = Array.isArray(host.missing_capabilities) ? host.missing_capabilities : [];
    let hostDegraded = Boolean(host.degraded || missingHostCaps.length > 0);

    // AC-SUF-01-07 (ED1) / P-1: Empty requirements list -> cannot-judge + "không có gì để yêu cầu"
    if (requirements.length === 0) {
        const selectedMode = mode || 'ask';
        return {
            level: 'cannot-judge',
            basis: 'declared', // D-63: basis of cannot-judge is declared
            cannot_judge_reason: 'no_requirement',
            mode: selectedMode === 'permitted' ? 'ask' : selectedMode, // INV-ESO-02
            mode_selected_by: mode_selected_by || 'system',
            requirements: [],
            answers: [],
            sat: [],
            unsat: [],
            gaps: [],
            unknowns: [{ what: 'requirements', reason: 'không có gì để yêu cầu' }],
            ratio: '0/0',
            assurance: hostDegraded ? 'DEGRADED' : 'FULL',
        };
    }

    const sat = [];
    const unsat = [];
    const evaluatedReqs = [];
    const unknowns = [];

    for (const req of requirements) {
        let ans = answersMap.get(req.subject);

        // AC-SUF-01-04: Host lacking required capability
        const reqMissingCap = missingHostCaps.find((cap) =>
            req.required_capability === cap || (req.asks && req.asks.includes(cap))
        );

        if (reqMissingCap) {
            hostDegraded = true;
            ans = {
                requirement: req.subject,
                claim: null,
                basis: 'inferred',
                exists: 'unknown',
                missing_capability: reqMissingCap,
                reason: `host thiếu năng lực: ${reqMissingCap}`,
            };
        } else if (!ans) {
            // AC-SUF-01-02: Untraceable requirement
            ans = {
                requirement: req.subject,
                claim: null,
                basis: 'inferred',
                exists: 'unknown',
                reason: 'đòi hỏi không tra được',
            };
        }

        const actualBasis = ans.basis || 'inferred';
        const actualExists = ans.exists || (ans.claim != null ? 'present' : 'absent');
        const minW = BASIS_WEIGHT[req.min_basis] || 1;
        const actW = BASIS_WEIGHT[actualBasis] || 1;

        // AC-SUF-01-06 (ED4): basis >= min_basis and present -> satisfied
        const isSat = actualExists === 'present' && actW >= minW;

        // AC-SUF-01-01: per-requirement level and basis
        let reqLevel;
        if (isSat) {
            reqLevel = 'sufficient';
        } else if (actualExists === 'unknown') {
            reqLevel = 'cannot-judge';
            unknowns.push({
                what: req.subject,
                source: req.source,
                reason: ans.reason || (reqMissingCap ? `host thiếu năng lực: ${reqMissingCap}` : 'đòi hỏi không tra được'),
                missing_capability: reqMissingCap || null,
            });
        } else {
            reqLevel = 'insufficient';
        }

        const isSourceGone = Boolean(req.source_deleted || req.source_gone);
        const whereHint = isSourceGone ? 'nguồn đã mất' : (req.where_hint || (req.source ? `từ nguồn ${req.source}` : 'không rõ nguồn'));

        const reqRecord = {
            subject: req.subject,
            asks: req.asks,
            min_basis: req.min_basis,
            source: req.source,
            where_hint: whereHint,
            source_gone: isSourceGone,
            level: reqLevel,
            basis: actualBasis,
            exists: actualExists,
            answer: ans,
        };

        evaluatedReqs.push(reqRecord);

        if (isSat) {
            sat.push(reqRecord);
        } else {
            unsat.push(reqRecord);
        }
    }

    // 2. Compute aggregate level (§3)
    let aggregateLevel;
    let cannotJudgeReason = null;

    if (unsat.length === 0) {
        aggregateLevel = 'sufficient';
    } else if (sat.length === 0) {
        if (unsat.some((r) => r.exists === 'present')) {
            aggregateLevel = 'unsurfaced';
        } else if (unsat.some((r) => r.exists === 'absent')) {
            aggregateLevel = 'insufficient';
        } else {
            aggregateLevel = 'cannot-judge'; // all unknown
            cannotJudgeReason = 'all_unknown';
        }
    } else {
        aggregateLevel = 'partial';
    }

    // 3. Compute aggregate basis (§3 & INV-ESO-01)
    let aggregateBasis;
    if (sat.length > 0) {
        aggregateBasis = minBasis(sat.map((r) => r.basis));
    } else if (aggregateLevel === 'cannot-judge') {
        aggregateBasis = 'declared'; // D-63
    } else {
        aggregateBasis = minBasis(unsat.map((r) => r.basis));
    }

    // 4. Compute gap list (AC-SUF-01-03, AC-SUF-05-04, AC-SUF-05-05)
    // Key: (source_order, blocking_first, seq)
    const gaps = unsat.map((r, idx) => ({
        what: r.subject,
        where_hint: r.where_hint || 'không rõ nguồn',
        source: r.source,
        source_gone: Boolean(r.source_gone),
        dangling_source: Boolean(r.source_gone),
        min_basis: r.min_basis,
        actual_basis: r.basis,
        exists: r.exists,
        _seq: idx,
    })).sort((a, b) => {
        const orderA = SOURCE_ORDER[a.source] || 99;
        const orderB = SOURCE_ORDER[b.source] || 99;
        if (orderA !== orderB) return orderA - orderB;

        // Blocking first: absent (1) < unknown (2) < present (3)
        const blockRank = (ex) => ex === 'absent' ? 1 : (ex === 'unknown' ? 2 : 3);
        const rankA = blockRank(a.exists);
        const rankB = blockRank(b.exists);
        if (rankA !== rankB) return rankA - rankB;

        return a._seq - b._seq;
    }).map(({ _seq, ...rest }) => rest);

    // 5. Mode assignment (AC-SUF-01-05 & INV-ESO-02)
    let finalMode = mode;
    if (!finalMode) {
        finalMode = aggregateLevel === 'sufficient' ? 'do' : 'ask';
    }

    // INV-ESO-02: cannot-judge never becomes permitted without bypass
    if (aggregateLevel === 'cannot-judge' && finalMode === 'permitted') {
        finalMode = 'ask';
    }

    return {
        level: aggregateLevel,
        basis: aggregateBasis,
        cannot_judge_reason: cannotJudgeReason || undefined,
        mode: finalMode,
        mode_selected_by: mode_selected_by || (mode ? 'actor' : 'system'),
        ratio: `${unsat.length}/${requirements.length}`,
        requirements: evaluatedReqs,
        sat,
        unsat,
        gaps,
        unknowns,
        assurance: hostDegraded ? 'DEGRADED' : 'FULL',
    };
}
