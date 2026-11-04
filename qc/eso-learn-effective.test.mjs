import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-14 (AC-LEARN-04-01): Window closed, unsat rate drops, defect rate does not rise -> effective: true + recorded metrics', () => {
    const proposal = {
        proposal_id: 'prop-eval-pass',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-31T00:00:00Z',
        },
    };

    const metrics = {
        before: { unsat_rate: 0.32, defect_rate: 0.08 },
        after: { unsat_rate: 0.18, defect_rate: 0.05 },
    };

    const result = evaluateEffectiveness({
        proposal,
        metrics,
        now: '2026-11-01T00:00:00Z',
    });

    assert.equal(result.concluded, true);
    assert.equal(result.effective, true);
    assert.equal(result.metrics.unsat.before, 0.32);
    assert.equal(result.metrics.unsat.after, 0.18);
    assert.equal(result.metrics.defect.before, 0.08);
    assert.equal(result.metrics.defect.after, 0.05);
});
