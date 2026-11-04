/**
 * @mu/eso-learn — Proposal Effectiveness Evaluation (US-LEARN-04 / ESO-165 / Slice S1)
 *
 * Implements:
 * - AC-LEARN-04-01: Window closed, unsat decreased, defect not increased => effective: true with both metrics
 * - AC-LEARN-04-02: Window closed, unsat decreased but defect increased => effective: false with both metrics
 * - AC-LEARN-04-03: Window still open => halts with NO_MEASUREMENT (0 conclusion)
 * - AC-LEARN-04-04: Missing one metric => halts with NO_MEASUREMENT (never infers from other)
 * - AC-LEARN-04-05: ED4 — defect_rate equal to previous => effective: true ("not increased" includes equal)
 * - AC-LEARN-04-06: ED8 — Window closed at exact boundary (now >= measure_to) => allowed
 * - AC-LEARN-04-07: Report missing before or after side => halts with NO_MEASUREMENT naming missing side
 */

export function evaluateEffectiveness({
    proposal,
    metrics,
    now = new Date().toISOString(),
} = {}) {
    if (!proposal || typeof proposal !== 'object') {
        const err = new Error('Proposal is required');
        err.code = 'INVALID_PROPOSAL';
        throw err;
    }

    if (proposal.status !== 'applied') {
        const err = new Error(`NO_MEASUREMENT: Proposal is in status '${proposal.status}', must be 'applied' to evaluate`);
        err.code = 'NO_MEASUREMENT';
        throw err;
    }

    const window = proposal.measure_window;
    if (!window || !window.to) {
        const err = new Error('NO_MEASUREMENT: Measurement window definition missing or has no end boundary');
        err.code = 'NO_MEASUREMENT';
        throw err;
    }

    // AC-LEARN-04-03 & AC-LEARN-04-06: Check window closure
    const windowEndTime = new Date(window.to).getTime();
    const currentTime = new Date(now).getTime();
    if (currentTime < windowEndTime) {
        const err = new Error(`NO_MEASUREMENT: Measure window is still open until '${window.to}' (cửa sổ còn mở)`);
        err.code = 'NO_MEASUREMENT';
        err.window_to = window.to;
        err.current_time = now;
        throw err;
    }

    // AC-LEARN-04-07: Check before/after existence
    if (!metrics || typeof metrics !== 'object') {
        const err = new Error('NO_MEASUREMENT: Metrics report is required');
        err.code = 'NO_MEASUREMENT';
        err.missing = ['before', 'after'];
        throw err;
    }

    const missingSides = [];
    if (!metrics.before) missingSides.push('before');
    if (!metrics.after) missingSides.push('after');
    if (missingSides.length > 0) {
        const err = new Error(`NO_MEASUREMENT: Metrics report is missing side(s): ${missingSides.join(', ')}`);
        err.code = 'NO_MEASUREMENT';
        err.missing = missingSides;
        throw err;
    }

    // AC-LEARN-04-04: Check both metrics present in both sides
    const missingMetrics = [];
    if (typeof metrics.before.unsat_rate !== 'number') missingMetrics.push('before.unsat_rate');
    if (typeof metrics.after.unsat_rate !== 'number') missingMetrics.push('after.unsat_rate');
    if (typeof metrics.before.defect_rate !== 'number') missingMetrics.push('before.defect_rate');
    if (typeof metrics.after.defect_rate !== 'number') missingMetrics.push('after.defect_rate');

    if (missingMetrics.length > 0) {
        const err = new Error(`NO_MEASUREMENT: Incomplete metrics; missing: ${missingMetrics.join(', ')} (không suy diễn)`);
        err.code = 'NO_MEASUREMENT';
        err.missing_metrics = missingMetrics;
        throw err;
    }

    const beforeUnsat = metrics.before.unsat_rate;
    const afterUnsat = metrics.after.unsat_rate;
    const beforeDefect = metrics.before.defect_rate;
    const afterDefect = metrics.after.defect_rate;

    // AC-LEARN-04-01: unsat decreases
    const unsatDecreased = afterUnsat < beforeUnsat;

    // AC-LEARN-04-05: defect does not increase (includes equal)
    const defectNotIncreased = afterDefect <= beforeDefect;

    // Overall effectiveness requires BOTH conditions
    const effective = unsatDecreased && defectNotIncreased;

    return {
        concluded: true,
        effective,
        metrics: {
            unsat: {
                before: beforeUnsat,
                after: afterUnsat,
                decreased: unsatDecreased,
            },
            defect: {
                before: beforeDefect,
                after: afterDefect,
                not_increased: defectNotIncreased,
            },
        },
        window,
        evaluated_at: now,
    };
}
