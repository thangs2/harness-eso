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
 *
 * @param {string|{ id: string }} question
 * @param {Record<string, number | { covered: number, total: number }>} perKindCoverage
 * @returns {{
 *   question: string,
 *   kinds: string[],
 *   value: number,
 *   status: 'ready' | 'unknown',
 *   coverage: number,
 *   perKind: Record<string, { coverage: number, covered?: number, total?: number }>
 * }}
 */
export function calculateCompleteness(question, perKindCoverage = {}) {
    const questionId = typeof question === 'string' ? question : (question?.id || 'Q1');
    const kinds = resolveQuestionKinds(questionId);

    const perKind = {};
    const ratios = [];

    for (const kind of kinds) {
        const item = perKindCoverage?.[kind];
        let ratio = 0;
        let covered;
        let total;

        if (typeof item === 'number') {
            ratio = Number.isFinite(item) ? Math.max(0, Math.min(1, item)) : 0;
        } else if (item && typeof item === 'object') {
            covered = Number(item.covered) || 0;
            total = Number(item.total) || 0;
            if (total > 0) {
                ratio = Math.max(0, Math.min(1, covered / total));
            } else if (total === 0) {
                // ESO-385: If a project does not have classes or methods declared (total === 0), do not force completeness to 0.
                ratio = 1;
            } else {
                ratio = 0;
            }
        } else if (item === undefined && (kind === 'class' || kind === 'method') && perKindCoverage?.file) {
            covered = 0;
            total = 0;
            ratio = 1;
        } else {
            ratio = 0;
        }

        perKind[kind] = {
            coverage: ratio,
            ...(covered !== undefined ? { covered } : {}),
            ...(total !== undefined ? { total } : {}),
        };
        ratios.push(ratio);
    }

    const rawMin = ratios.length > 0 ? Math.min(...ratios) : 0;
    const value = Number.isFinite(rawMin) ? Math.max(0, Math.min(1, rawMin)) : 0;

    const isComplete = value >= 1.0 && ratios.every((r) => r >= 1.0);
    const status = isComplete ? 'ready' : 'unknown';

    return {
        question: typeof question === 'string' ? question : questionId,
        kinds,
        value,
        status,
        coverage: value,
        perKind,
    };
}
