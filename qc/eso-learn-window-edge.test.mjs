import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateEffectiveness,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-27 (AC-LEARN-04-06 & ED8): Window evaluated at exact boundary timestamp (now === measure_to) is eligible and concludes', () => {
    const windowTo = '2026-10-31T23:59:59.999Z';
    const proposal = {
        proposal_id: 'prop-eval-exact-edge',
        status: 'applied',
        measure_window: {
            from: '2026-10-01T00:00:00Z',
            to: windowTo,
        },
    };

    const metrics = {
        before: { unsat_rate: 0.25, defect_rate: 0.05 },
        after: { unsat_rate: 0.12, defect_rate: 0.05 },
    };

    const result = evaluateEffectiveness({
        proposal,
        metrics,
        now: windowTo, // Exact boundary
    });

    assert.equal(result.concluded, true);
    assert.equal(result.effective, true);
});
