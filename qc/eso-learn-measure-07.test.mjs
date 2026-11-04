import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-32 (AC-LEARN-04-07): Report missing before or after dataset halts with NO_MEASUREMENT naming missing side', () => {
    const proposal = {
        proposal_id: 'prop-eval-missing-side',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-31T00:00:00Z',
        },
    };

    // Missing 'before' dataset completely
    const metricsWithoutBefore = {
        after: { unsat_rate: 0.10, defect_rate: 0.02 },
    };

    assert.throws(() => {
        evaluateEffectiveness({
            proposal,
            metrics: metricsWithoutBefore,
            now: '2026-11-01T00:00:00Z',
        });
    }, (err) => {
        assert.equal(err.code, 'NO_MEASUREMENT');
        assert.ok(err.missing.includes('before'));
        return true;
    });
});
