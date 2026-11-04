import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-33 (AC-LEARN-05-07): Reverting from 1.4 decrements version by exactly one (1.3); proposal remains readable', () => {
    const applied = {
        proposal_id: 'prop-version-step-back',
        version: '1.4',
        status: 'applied',
        evidence: ['gap-1'],
        expected_effect: 'lower unsat_rate',
        revert: { action: 'rollback_rule' },
    };

    const reverted = revertProposal({
        proposal: applied,
        actor: 'operator',
    });

    assert.equal(reverted.version, '1.3', 'Version decreases from 1.4 to 1.3');
    assert.equal(reverted.status, 'reverted');
    assert.ok(reverted.proposal_id);
    assert.ok(reverted.expected_effect);
});
