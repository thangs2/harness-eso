/**
 * Dispatcher for ESO queries (INV-GR-01, AC-ARCH-01-03).
 *
 * Invariants:
 * - INV-GR-01: Extractor does not run on the turn path (AC-ARCH-01-03).
 */

const HEAVY_QUERY_PATTERNS = [
    /\bextract\b/i,
    /\bast[_-]?extract\b/i,
    /\breindex\b/i,
    /\bfull[_-]?scan\b/i,
    /\bparse[_-]?all\b/i,
    /\bdeep[_-]?crawl\b/i,
];

/**
 * Check whether a question or query is safe to execute on the turn path.
 * @param {string|{ query?: string, type?: string, heavy?: boolean, offPath?: boolean }} question
 * @returns {boolean}
 */
export function isTurnSafe(question) {
    if (!question) return true;

    if (typeof question === 'object') {
        if (question.heavy || question.offPath) return false;
        if (question.type === 'extract' || question.type === 'reindex') return false;
        const text = question.query || question.id || '';
        return !HEAVY_QUERY_PATTERNS.some((pattern) => pattern.test(text));
    }

    if (typeof question === 'string') {
        return !HEAVY_QUERY_PATTERNS.some((pattern) => pattern.test(question));
    }

    return true;
}

/**
 * Dispatch query respecting the on-path / off-path boundary (INV-GR-01).
 * Heavy extraction is pushed off-path into asynchronous background queue.
 */
export async function dispatchQuery(question, runner, options = {}) {
    const turnSafe = isTurnSafe(question);

    if (turnSafe) {
        const result = await runner(question);
        return {
            mode: 'on-path',
            completed: true,
            result,
        };
    }

    const job = {
        id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        question,
        status: 'queued',
        createdAt: new Date().toISOString(),
    };

    if (Array.isArray(options.offPathQueue)) {
        options.offPathQueue.push(job);
    }

    if (typeof options.backgroundRunner === 'function') {
        queueMicrotask(() => {
            options.backgroundRunner(job).catch(() => {});
        });
    }

    return {
        mode: 'off-path',
        completed: false,
        queued: true,
        job,
    };
}
