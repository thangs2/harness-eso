import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-08 (AC-LEARN-03-03): Applying already applied proposal rejected with ALREADY_APPLIED (single window strictly enforced)', () => {
    const appliedProposal = {
        proposal_id: 'prop-apply-002',
        version: 2,
        status: 'applied',
        revert: { action: 'rollback_rule' },
        measure_from: '2026-11-01T00:00:00.000Z',
        measure_to: '2026-12-01T00:00:00.000Z',
    };

    assert.throws(() => {
        applyProposalToSystem({
            proposal: appliedProposal,
            actor: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'ALREADY_APPLIED');
        assert.equal(err.proposal_id, 'prop-apply-002');
        return true;
    });
});
