import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-28 (AC-LEARN-05-05 & ED6): Reverting already reverted proposal rejected with NOT_APPLIED (0 changes)', () => {
    const revertedProposal = {
        proposal_id: 'prop-revert-twice',
        version: 1,
        status: 'reverted',
    };

    assert.throws(() => {
        revertProposal({
            proposal: revertedProposal,
            actor: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'NOT_APPLIED');
        assert.equal(err.status, 'reverted');
        return true;
    });
});
