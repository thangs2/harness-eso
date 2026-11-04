import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-16 (AC-LEARN-04-04): Missing either unsat or defect metric halts with NO_MEASUREMENT (never assumes from remaining)', () => {
    const proposal = {
        proposal_id: 'prop-eval-one-metric',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-31T00:00:00Z',
        },
    };

    // Missing defect_rate on after side
    const partialMetrics = {
        before: { unsat_rate: 0.30, defect_rate: 0.05 },
        after: { unsat_rate: 0.15 },
    };

    assert.throws(() => {
        evaluateEffectiveness({
            proposal,
            metrics: partialMetrics,
            now: '2026-11-01T00:00:00Z',
        });
    }, (err) => {
        assert.equal(err.code, 'NO_MEASUREMENT');
        assert.ok(err.missing_metrics.includes('after.defect_rate'));
        return true;
    });
});
