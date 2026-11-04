import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-18 (AC-LEARN-05-03): Reversion closes measurement window and sets measurement_state to halted', () => {
    const applied = {
        proposal_id: 'prop-revert-window-check',
        version: 2,
        status: 'applied',
        measure_window: { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' },
    };

    const reverted = revertProposal({
        proposal: applied,
        actor: 'operator',
        now: '2026-11-05T00:00:00Z',
    });

    assert.equal(reverted.status, 'reverted');
    assert.equal(reverted.measurement_state, 'halted');
    assert.equal(reverted.measure_window.active, false);
    assert.equal(reverted.measure_window.closed_at, '2026-11-05T00:00:00Z');
});
