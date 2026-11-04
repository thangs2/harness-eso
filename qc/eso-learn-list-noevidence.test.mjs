import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listProposals,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-06 (AC-LEARN-02-02): Proposal without attached risk evidence is omitted or marked OUT with NO_EVIDENCE', () => {
    const rawProposals = [
        {
            proposal_id: 'prop-valid',
            evidence: ['gap-1'],
            expected_effect: 'defect_rate stable',
            revert: { rollback: true },
        },
        {
            proposal_id: 'prop-no-risk',
            evidence: [], // No evidence
            expected_effect: 'pure opinion without data',
            revert: { rollback: true },
        },
    ];

    // Standard review view: omits non-evidenced proposals
    const cleanList = listProposals({ proposals: rawProposals });
    assert.equal(cleanList.total, 1);
    assert.equal(cleanList.items[0].proposal_id, 'prop-valid');

    // Audit view with includeInvalid: shows OUT + NO_EVIDENCE
    const auditList = listProposals({ proposals: rawProposals, includeInvalid: true });
    assert.equal(auditList.total, 2);
    const flagged = auditList.items.find((p) => p.proposal_id === 'prop-no-risk');
    assert.equal(flagged.display_status, 'OUT');
    assert.equal(flagged.out_reason, 'NO_EVIDENCE');
});
