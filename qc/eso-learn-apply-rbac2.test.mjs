import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-12 (AC-LEARN-03-02): Agent calling learning:apply is rejected with APPLY_FORBIDDEN (0 changes made)', () => {
    const proposal = {
        proposal_id: 'prop-agent-gate',
        version: 1,
        status: 'proposed',
        revert: { action: 'rollback_rule' },
    };

    assert.throws(() => {
        applyProposalToSystem({
            proposal,
            actor: 'agent',
        });
    }, (err) => {
        assert.equal(err.code, 'APPLY_FORBIDDEN');
        assert.equal(err.actor, 'agent');
        return true;
    });

    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.version, 1);
});
