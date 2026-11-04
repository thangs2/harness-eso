import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-26 (AC-LEARN-04-05 & ED4): Equal defect rate counts as "not increased" -> effective: true', () => {
    const proposal = {
        proposal_id: 'prop-eval-defect-equal',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-31T00:00:00Z',
        },
    };

    const metrics = {
        before: { unsat_rate: 0.28, defect_rate: 0.04 },
        after: { unsat_rate: 0.16, defect_rate: 0.04 }, // Exactly equal!
    };

    const result = evaluateEffectiveness({
        proposal,
        metrics,
        now: '2026-11-01T00:00:00Z',
    });

    assert.equal(result.concluded, true);
    assert.equal(result.effective, true);
    assert.equal(result.metrics.defect.not_increased, true);
});
