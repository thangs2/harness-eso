import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-25 (AC-LEARN-03-06 & ED7): Two concurrent apply attempts: first succeeds, second fails with ALREADY_APPLIED', () => {
    let currentProposal = {
        proposal_id: 'prop-race-check',
        version: 1,
        status: 'proposed',
        revert: { action: 'rollback_rule' },
    };

    // Attempt 1 succeeds
    const res1 = applyProposalToSystem({
        proposal: currentProposal,
        actor: 'operator',
        now: '2026-11-04T00:00:00Z',
    });
    assert.equal(res1.status, 'applied');
    assert.equal(res1.version, 2);

    // Update state
    currentProposal = res1;

    // Attempt 2 fails
    assert.throws(() => {
        applyProposalToSystem({
            proposal: currentProposal,
            actor: 'operator',
            now: '2026-11-04T00:00:01Z',
        });
    }, (err) => {
        assert.equal(err.code, 'ALREADY_APPLIED');
        return true;
    });

    // Exactly one window opened
    assert.equal(currentProposal.version, 2);
    assert.equal(currentProposal.measure_from, '2026-11-04T00:00:00Z');
});
