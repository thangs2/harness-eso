import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-17 (AC-LEARN-05-02): Reverting proposal in proposed status rejected with NOT_APPLIED (0 changes)', () => {
    const proposed = {
        proposal_id: 'prop-revert-premature',
        version: 1,
        status: 'proposed',
    };

    assert.throws(() => {
        revertProposal({
            proposal: proposed,
            actor: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'NOT_APPLIED');
        assert.equal(err.status, 'proposed');
        return true;
    });

    assert.equal(proposed.status, 'proposed');
});
