import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-15 (AC-LEARN-04-03): Evaluating while measurement window is still open halts with NO_MEASUREMENT (0 conclusion)', () => {
    const proposal = {
        proposal_id: 'prop-eval-window-open',
        status: 'applied',
        measure_window: {
            from: '2026-11-01T00:00:00Z',
            to: '2026-11-30T00:00:00Z',
        },
    };

    const metrics = {
        before: { unsat_rate: 0.30, defect_rate: 0.05 },
        after: { unsat_rate: 0.15, defect_rate: 0.04 },
    };

    assert.throws(() => {
        evaluateEffectiveness({
            proposal,
            metrics,
            now: '2026-11-20T00:00:00Z', // In open window!
        });
    }, (err) => {
        assert.equal(err.code, 'NO_MEASUREMENT');
        assert.match(err.message, /cửa sổ còn mở/);
        return true;
    });
});
