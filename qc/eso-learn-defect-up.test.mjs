import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-09 (AC-LEARN-04-02): Window closed, unsat rate drops but defect rate rises -> effective: false with both metrics', () => {
    const proposal = {
        proposal_id: 'prop-eval-defect-up',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-31T00:00:00Z',
        },
    };

    const metrics = {
        before: { unsat_rate: 0.30, defect_rate: 0.05 },
        after: { unsat_rate: 0.15, defect_rate: 0.12 }, // Defect went up!
    };

    const result = evaluateEffectiveness({
        proposal,
        metrics,
        now: '2026-11-01T00:00:00Z',
    });

    assert.equal(result.concluded, true);
    assert.equal(result.effective, false);
    assert.equal(result.metrics.unsat.decreased, true);
    assert.equal(result.metrics.defect.not_increased, false);
});
