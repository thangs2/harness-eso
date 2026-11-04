/**
 * @mu/eso-core — Types & Closed Vocabularies (ESO-95 / US-SUF-01 / Slice S1)
 *
 * Invariants:
 * - BR-04: Requirement source must be one of: bar, work, blast, declared.
 * - Closed constraints on level, mode, basis, exists.
 */

export const SOURCES = Object.freeze([
    'bar',
    'work',
    'blast',
    'declared',
]);

export const LEVELS = Object.freeze([
    'insufficient',
    'partial',
    'sufficient',
    'cannot-judge',
    'unsurfaced',
]);

export const MODES = Object.freeze([
    'block',
    'ask',
    'do',
    'permitted',
    'bypassed',
]);

export const BASES = Object.freeze([
    'inferred',
    'retrieved',
    'verified',
]);

export const BASIS_WEIGHT = Object.freeze({
    inferred: 1,
    retrieved: 2,
    verified: 3,
});

export const EXISTS = Object.freeze([
    'present',
    'absent',
    'unknown',
]);

export const CANNOT_JUDGE_REASONS = Object.freeze([
    'no_requirement',
    'all_unknown',
    'missing_graph',
]);

/**
 * Validates a single requirement definition.
 * Throws SOURCE_MISSING if source is absent, invalid, or outside closed vocabulary (BR-04, AC-SUF-01-08).
 */
export function assertValidRequirement(req) {
    if (!req || typeof req !== 'object') {
        const err = new Error('SOURCE_MISSING: requirement object is required');
        err.code = 'SOURCE_MISSING';
        throw err;
    }

    if (!req.source || typeof req.source !== 'string' || !SOURCES.includes(req.source.trim())) {
        const err = new Error(`SOURCE_MISSING: requirement source must be one of [${SOURCES.join(', ')}], received '${req.source}'`);
        err.code = 'SOURCE_MISSING';
        throw err;
    }

    if (!req.subject || typeof req.subject !== 'string' || req.subject.trim() === '') {
        const err = new Error('INVALID_REQUIREMENT: requirement subject is required');
        err.code = 'INVALID_REQUIREMENT';
        throw err;
    }

    if (!req.min_basis || !BASES.includes(req.min_basis)) {
        const err = new Error(`INVALID_REQUIREMENT: min_basis must be one of [${BASES.join(', ')}]`);
        err.code = 'INVALID_REQUIREMENT';
        throw err;
    }

    return true;
}
