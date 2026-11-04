/**
 * @mu/eso-core — Proactive Warnings (ESO-115 / US-SUF-03 / Slice S1)
 *
 * Implements:
 * - AC-SUF-03-01: Proactive warning emitted unprompted when task is about to run with level < sufficient.
 * - AC-SUF-03-02 & AC-SUF-03-04: Deduplication: already warned (task, requirement) is not warned again (count = 1).
 * - AC-SUF-03-03 (BR-07): Non-blocking: task continues, mode is not forced to block.
 * - AC-SUF-03-05: When 0 requirements are below sufficient, no warning is emitted and no empty warning is created.
 * - AC-SUF-03-06: False-positive = 0: When level is sufficient, no warning is emitted.
 */

/**
 * Evaluates whether to emit a proactive warning before task dispatch and tracks deduplication.
 *
 * @param {object} params
 * @param {object} params.verdict Sufficiency verdict from judgeSufficiency
 * @param {string} params.task_id Task identifier
 * @param {string} [params.project='*'] Project identifier
 * @param {string} [params.turn_id='*'] Turn identifier
 * @param {Set|Map} [params.historyState=new Set()] State tracker for warned (project, task, req) tuples
 * @returns {object} Warning issuance result
 */
export function emitProactiveWarning({
    verdict,
    task_id,
    project = '*',
    turn_id = '*',
    historyState = new Set(),
} = {}) {
    if (!verdict || typeof verdict !== 'object') {
        throw new Error('Verdict object is required');
    }

    // AC-SUF-03-05 & AC-SUF-03-06: When level is sufficient or no unsat gaps exist, emit NOTHING (false-positive = 0)
    if (verdict.level === 'sufficient' || !Array.isArray(verdict.gaps) || verdict.gaps.length === 0) {
        return {
            warned: false,
            warnings: [],
            message: null,
            blocked: false,
        };
    }

    const taskId = String(task_id || 'anonymous_task').trim();
    const projId = String(project || '*').trim();
    const turnId = String(turn_id || '*').trim();

    const newWarnings = [];

    for (const gap of verdict.gaps) {
        // Natural deduplication key: (project, task_id, req_subject)
        const dedupKey = `${projId}:${taskId}:${gap.what}`;

        if (!historyState.has(dedupKey)) {
            historyState.add(dedupKey);

            newWarnings.push({
                task_id: taskId,
                requirement: gap.what,
                where_hint: gap.where_hint || 'không rõ nguồn',
                source: gap.source,
                exists: gap.exists,
                min_basis: gap.min_basis,
            });
        }
    }

    // AC-SUF-03-02 & AC-SUF-03-04: If all gaps were already warned, do not emit again
    if (newWarnings.length === 0) {
        return {
            warned: false,
            warnings: [],
            message: null,
            deduplicated: true,
            blocked: false,
        };
    }

    // AC-SUF-03-01 & AC-SUF-03-03: Proactive warning emitted, non-blocking (mode is preserved)
    return {
        warned: true,
        level: verdict.level,
        task_id: taskId,
        warnings: newWarnings,
        blocked: false, // BR-07: Proactive warning NEVER blocks task
        mode: verdict.mode, // Preserves mode without forcing block
        message: `[CẢNH BÁO TỰ PHÁT] Việc '${taskId}' chuẩn bị chạy khi mức bằng chứng là '${verdict.level}' (${newWarnings.length} mục thiếu)`,
    };
}
