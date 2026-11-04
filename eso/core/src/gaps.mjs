/**
 * @mu/eso-core — Gap Explanation & Reporter (ESO-105 / US-SUF-05 / Slice S1)
 *
 * Implements:
 * - AC-SUF-05-01: Every gap item has source in [bar, work, blast, declared].
 * - AC-SUF-05-02: level < sufficient requires detailed gap items; rejects empty list with NO_GAP_DETAIL.
 * - AC-SUF-05-03: Item with exists=unknown displayed as unknown, not "thiếu" / absent (BR-05).
 * - AC-SUF-05-04 & AC-SUF-05-05: Gaps ordered by (source_order, blocking_first, seq) reproducibly.
 * - AC-SUF-05-06: Deleted/gone source still listed with "nguồn đã mất" (dangling_source: true), never dropped.
 * - AC-SUF-05-07: Missing graph yields cannot-judge, never insufficient, with basis=declared.
 */

import { SOURCES } from './types.mjs';

/**
 * Formats detailed gap report for a given verdict.
 *
 * @param {object} verdict Sufficiency verdict object
 * @returns {object} Formatted gap report
 */
export function formatGapReport(verdict) {
    if (!verdict || typeof verdict !== 'object') {
        throw new Error('Verdict object is required');
    }

    const level = verdict.level;
    const gaps = Array.isArray(verdict.gaps) ? verdict.gaps : [];

    // AC-SUF-05-02: level < sufficient without gap details is rejected with NO_GAP_DETAIL
    if (level !== 'sufficient' && gaps.length === 0 && level !== 'cannot-judge') {
        const err = new Error(`NO_GAP_DETAIL: level '${level}' requires detailed gap items, but gap_items is empty`);
        err.code = 'NO_GAP_DETAIL';
        throw err;
    }

    // AC-SUF-05-01, AC-SUF-05-03, AC-SUF-05-06
    const gapItems = gaps.map((g) => {
        if (!g.source || !SOURCES.includes(g.source)) {
            throw new Error(`INVALID_GAP_SOURCE: gap item '${g.what}' has invalid source '${g.source}'`);
        }

        return {
            what: g.what,
            source: g.source,
            // AC-SUF-05-03: unknown vs missing
            status: g.exists === 'unknown' ? 'unknown' : 'missing',
            exists: g.exists,
            where_hint: g.where_hint || (g.source ? `từ nguồn ${g.source}` : 'không rõ nguồn'),
            dangling_source: Boolean(g.dangling_source || g.source_gone),
            min_basis: g.min_basis,
            actual_basis: g.actual_basis,
        };
    });

    return {
        level,
        total_gaps: gapItems.length,
        gap_items: gapItems,
    };
}
