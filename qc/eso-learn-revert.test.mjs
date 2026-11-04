import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-10 (AC-LEARN-05-01): Operator reverts applied proposal in a single action -> status reverted with audit record', () => {
    const applied = {
        proposal_id: 'prop-revert-happy',
        version: 2,
        status: 'applied',
        measure_window: { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' },
    };

    const reverted = revertProposal({
        proposal: applied,
        actor: 'operator',
        now: '2026-11-05T12:00:00Z',
        reason: 'Rollback initiated by QA lead',
    });

    assert.equal(reverted.status, 'reverted');
    assert.equal(reverted.reverted_by, 'operator');
    assert.equal(reverted.reverted_at, '2026-11-05T12:00:00Z');
    assert.equal(reverted.revert_reason, 'Rollback initiated by QA lead');
});
