/**
 * Completeness calculation for ESO Graph (AC-ARCH-01-02, BR-05).
 *
 * Invariants:
 * - BR-05: unknown != absent: completeness is NOT NULL, covered < total rendered as unknown + coverage, never absent.
 */

export const QUESTION_KIND_MAP = Object.freeze({
    Q1: Object.freeze(['file', 'class', 'method']),
    Q2: Object.freeze(['table', 'entity', 'column']),
    Q3: Object.freeze(['module', 'package']),
    Q4: Object.freeze(['endpoint', 'permission', 'grant']),
    Q5: Object.freeze(['slice', 'table', 'tenant_marker']),
});

/**
 * Resolve question key to kinds set K(Q).
 * @param {string|{ id: string }} question
 * @returns {string[]}
 */
export function resolveQuestionKinds(question) {
    const qId = typeof question === 'string' ? question.trim() : (question?.id || '');
    const upper = qId.toUpperCase();
    if (upper in QUESTION_KIND_MAP) {
        return [...QUESTION_KIND_MAP[upper]];
    }
    for (const [key, kinds] of Object.entries(QUESTION_KIND_MAP)) {
        if (upper.startsWith(key)) {
            return [...kinds];
        }
    }
    return ['file'];
}

/**
 * Calculate completeness for a question given coverage metrics per kind.
 *
 * Requirements:
 * - K(Q) mapping: Q1 -> [file, class, method], Q2 -> [table, entity, column], Q3 -> [module, package]
 * - value = min(coverage(k)) across K(Q)
 * - enforce BR-05: value is ALWAYS numeric 0..1 (NOT NULL), if covered < total or value < 1.0,
 *   status is 'unknown' with coverage ratio, NEVER 'absent'.
 * - ESO-385: When total === 0 for class or method (or any kind), coverage must NOT default to 1.0!
 *   total === 0 or undefined is treated as coverage: null / unknown (status = 'unknown').
 *
 * @param {string|{ id: string }} question
 * @param {Record<string, number | { covered: number, total: number }>} perKindCoverage
 * @returns {{
 *   question: string,
 *   kinds: string[],
 *   value: number,
 *   status: 'ready' | 'unknown',
 *   coverage: number | null,
 *   perKind: Record<string, { coverage: number | null, status: 'ready' | 'unknown', covered?: number, total?: number }>
 * }}
 */
export function calculateCompleteness(question, perKindCoverage = {}) {
    const questionId = typeof question === 'string' ? question : (question?.id || 'Q1');
    const kinds = resolveQuestionKinds(questionId);

    const perKind = {};
    const ratios = [];
    let hasUnknownOrNull = false;

    for (const kind of kinds) {
        const item = perKindCoverage?.[kind];
        let ratio = null;
        let covered;
        let total;

        if (typeof item === 'number') {
            if (Number.isFinite(item)) {
                ratio = Math.max(0, Math.min(1, item));
            } else {
                ratio = null;
            }
        } else if (item && typeof item === 'object') {
            covered = typeof item.covered === 'number' ? item.covered : (Number(item.covered) || 0);
            total = typeof item.total === 'number' ? item.total : (Number(item.total) || 0);
            if (total > 0) {
                ratio = Math.max(0, Math.min(1, covered / total));
            } else {
                // ESO-385: When total === 0, coverage must NOT default to 1.0!
                // Treat as coverage: null and status: 'unknown'
                ratio = null;
            }
        } else {
            // Undefined or missing kind
            ratio = null;
        }

        if (ratio === null) {
            hasUnknownOrNull = true;
        } else {
            ratios.push(ratio);
        }

        perKind[kind] = {
            coverage: ratio,
            status: (ratio !== null && ratio >= 1.0) ? 'ready' : 'unknown',
            ...(covered !== undefined ? { covered } : {}),
            ...(total !== undefined ? { total } : {}),
        };
    }

    const isComplete = !hasUnknownOrNull && ratios.length === kinds.length && ratios.every((r) => r >= 1.0);
    const status = isComplete ? 'ready' : 'unknown';

    // If any required kind has null/unknown coverage, status is 'unknown', value is 0 (BR-05 numeric),
    // and coverage is marked unknown (null).
    const rawMin = ratios.length > 0 ? Math.min(...ratios) : 0;
    const value = hasUnknownOrNull ? 0 : (Number.isFinite(rawMin) ? Math.max(0, Math.min(1, rawMin)) : 0);
    const coverage = hasUnknownOrNull ? null : value;

    return {
        question: typeof question === 'string' ? question : questionId,
        kinds,
        value,
        status,
        coverage,
        perKind,
    };
}
