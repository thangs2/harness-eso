import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    rejectProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-30 (AC-LEARN-02-06): Rejection without reason is refused with NO_REASON; proposal status remains proposed', () => {
    const proposal = {
        proposal_id: 'prop-reject-test',
        project: 'baplatform',
        status: 'proposed',
        evidence: ['gap-1', 'gap-2'],
    };

    // 1. Rejection without reason fails
    assert.throws(() => {
        rejectProposal({
            proposal,
            reason: '',
        });
    }, (err) => {
        assert.equal(err.code, 'NO_REASON');
        assert.match(err.message, /kèm lý do/);
        return true;
    });

    // Verify proposal remains unchanged
    assert.equal(proposal.status, 'proposed');

    // 2. Rejection with reason succeeds
    const rejected = rejectProposal({
        proposal,
        reason: 'Duplicate of PR-402 with insufficient benchmark evidence',
        actor: 'operator',
    });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejection_reason, 'Duplicate of PR-402 with insufficient benchmark evidence');
    assert.equal(rejected.rejected_by, 'operator');
    assert.ok(rejected.rejected_at);
});
