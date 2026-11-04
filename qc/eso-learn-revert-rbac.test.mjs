import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-19 (AC-LEARN-05-04): Agent actor attempting to revert is rejected with APPLY_FORBIDDEN (0 changes)', () => {
    const applied = {
        proposal_id: 'prop-agent-revert-check',
        version: 2,
        status: 'applied',
    };

    assert.throws(() => {
        revertProposal({
            proposal: applied,
            actor: 'agent',
        });
    }, (err) => {
        assert.equal(err.code, 'APPLY_FORBIDDEN');
        assert.equal(err.actor, 'agent');
        return true;
    });

    assert.equal(applied.status, 'applied');
});
