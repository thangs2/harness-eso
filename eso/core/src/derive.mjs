/**
 * @mu/eso-core — Requirement Derivation (ESO-95 / US-SUF-01 / Slice S1)
 *
 * Implements requirement compilation from four sources:
 * - bar: policy requirements defined on the actor role
 * - work: AC and invariants declared in ticket
 * - blast: interface contracts inferred from graph blast radius
 * - declared: explicit invariants/declarations from project knowledge base
 *
 * Invariants:
 * - BR-04: Every derived requirement must name its source.
 * - AC-SUF-01-08: Any requirement missing source or with invalid source is rejected with SOURCE_MISSING.
 *   0 requirements are loaded on error (never returns empty array on invalid input).
 */

import { assertValidRequirement } from './types.mjs';

/**
 * Derives and validates a complete set of requirements from task inputs.
 *
 * @param {object} params Derivation sources
 * @param {Array} [params.bar=[]] Role policy bars
 * @param {Array} [params.work=[]] Task AC/INV requirements
 * @param {Array} [params.blast=[]] Impacted interfaces from blast radius
 * @param {Array} [params.declared=[]] Project declared rules
 * @returns {Array} List of validated Requirement objects
 */
export function deriveRequirements({ bar = [], work = [], blast = [], declared = [] } = {}) {
    const rawItems = [
        ...bar.map((b) => ({ ...b, source: ('source' in b && b.source !== undefined) ? b.source : 'bar' })),
        ...work.map((w) => ({ ...w, source: ('source' in w && w.source !== undefined) ? w.source : 'work' })),
        ...blast.map((bl) => ({ ...bl, source: ('source' in bl && bl.source !== undefined) ? bl.source : 'blast' })),
        ...declared.map((d) => ({ ...d, source: ('source' in d && d.source !== undefined) ? d.source : 'declared' })),
    ];

    const requirements = [];

    for (const item of rawItems) {
        // Enforce per-requirement validation & source presence
        assertValidRequirement(item);

        requirements.push({
            subject: item.subject.trim(),
            asks: item.asks ? item.asks.trim() : 'contract',
            min_basis: item.min_basis,
            source: item.source.trim(),
            where_hint: item.where_hint || (item.source ? `từ nguồn ${item.source}` : 'không rõ nguồn'),
        });
    }

    return requirements;
}
