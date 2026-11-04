/**
 * @mu/eso-core — Operator Sufficiency Explanation & Formatting (ESO-100 / US-SUF-02 / Slice S1)
 *
 * Implements:
 * - AC-SUF-02-01: Explains to operator: việc gì (what task), thiếu gì (what missing), cần cung cấp gì (what needed), in plain language.
 * - AC-SUF-02-02: Missing user declaration yields explicit "cần bạn khai X", never assumes a default value.
 * - AC-SUF-02-03: cannot-judge yields "không phán được" + reason; strictly forbids scores or percentages.
 * - AC-SUF-02-04: Operator bypass allows execution without altering verdict level (bypassed with operator + deadline).
 * - AC-SUF-02-05: Countable missing items (ratio |unsat|/|reqs|) + primary blocker without silent truncation.
 * - AC-SUF-02-06: Deleted/gone source still listed with "nguồn đã mất", never omitted, never guessing.
 * - AC-SUF-02-07: Deterministic pure function without profile threshold dependencies.
 */

/**
 * Formats a sufficiency verdict into a human-readable operator explanation.
 *
 * @param {object} verdict Sufficiency verdict from judgeSufficiency
 * @param {object} [options={}] Formatting options
 * @param {string} [options.task_description=''] Plain-language task description
 * @param {object} [options.bypass=null] Bypass details { by, reason, expires_at }
 * @returns {object} Operator-facing report
 */
export function formatOperatorExplanation(verdict, { task_description = '', bypass = null } = {}) {
    if (!verdict || typeof verdict !== 'object') {
        throw new Error('Verdict object is required');
    }

    const taskText = task_description.trim() || 'Công việc được yêu cầu';
    const missingGaps = Array.isArray(verdict.gaps) ? verdict.gaps : [];
    const totalMissing = missingGaps.length;
    const totalReqs = Array.isArray(verdict.requirements) ? verdict.requirements.length : 0;

    // AC-SUF-02-01 & AC-SUF-02-02: Build plain-language needs & missing items
    const missingItems = [];
    const neededActions = [];
    const userDeclarationsNeeded = [];

    for (const gap of missingGaps) {
        missingItems.push(gap.what);

        if (gap.source_gone) {
            neededActions.push(`nguồn đã mất cho ${gap.what}: cần khôi phục khai báo`);
        } else if (gap.source === 'declared') {
            const declText = `cần bạn khai ${gap.what}`;
            neededActions.push(declText);
            userDeclarationsNeeded.push(gap.what);
        } else {
            neededActions.push(`cung cấp thông tin về ${gap.what} (${gap.where_hint || 'từ nguồn ' + gap.source})`);
        }
    }

    // AC-SUF-02-03: When cannot-judge, state "không phán được" + reason, NEVER output score/percentage
    let cannotJudgeNotice = null;
    if (verdict.level === 'cannot-judge') {
        const reason = verdict.unknowns?.[0]?.reason || 'hệ thiếu mô hình để phán';
        cannotJudgeNotice = `không phán được: ${reason}`;
    }

    // AC-SUF-02-04: If bypassed, record operator + expires_at, level remains unchanged
    let activeMode = verdict.mode;
    let bypassRecord = null;
    if (bypass) {
        if (!bypass.by || !bypass.expires_at) {
            throw new Error('Bypass requires both operator identity (by) and expiration deadline (expires_at)');
        }
        activeMode = 'bypassed';
        bypassRecord = {
            bypassed_by: bypass.by,
            reason: bypass.reason || 'Operator override',
            expires_at: bypass.expires_at,
        };
    }

    // AC-SUF-02-05: Countable number of items + primary blocker
    const primaryBlocker = missingGaps.length > 0 ? missingGaps[0].what : null;

    return {
        task: taskText,
        level: verdict.level, // Preserved strictly, never elevated to sufficient
        basis: verdict.basis,
        mode: activeMode,
        summary: {
            task: taskText,
            missing: missingItems,
            actions_needed: neededActions,
        },
        user_declarations_needed: userDeclarationsNeeded,
        cannot_judge_notice: cannotJudgeNotice,
        // AC-SUF-02-03 strict guard: no score, no percentage
        score: undefined,
        percentage: undefined,
        total_missing: totalMissing,
        total_requirements: totalReqs,
        ratio: verdict.ratio || `${totalMissing}/${totalReqs}`,
        primary_blocker: primaryBlocker,
        bypass: bypassRecord,
        gaps: missingGaps,
    };
}
