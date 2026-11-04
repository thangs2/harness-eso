import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listProposals,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-11 (AC-LEARN-02-03): Applied proposal shows measure_window and measuring or concluded state', () => {
    const currentTime = '2026-11-04T00:00:00Z';
    const rawProposals = [
        {
            proposal_id: 'prop-active-measuring',
            status: 'applied',
            evidence: ['gap-1'],
            measure_window: {
                from: '2026-11-01T00:00:00Z',
                to: '2026-11-15T00:00:00Z',
            },
        },
        {
            proposal_id: 'prop-past-concluded',
            status: 'applied',
            evidence: ['gap-2'],
            measure_window: {
                from: '2026-10-01T00:00:00Z',
                to: '2026-10-25T00:00:00Z',
            },
        },
    ];

    const result = listProposals({ proposals: rawProposals, now: currentTime });
    const p1 = result.items.find((p) => p.proposal_id === 'prop-active-measuring');
    const p2 = result.items.find((p) => p.proposal_id === 'prop-past-concluded');

    assert.equal(p1.measurement_state, 'measuring');
    assert.equal(p2.measurement_state, 'concluded');
});
