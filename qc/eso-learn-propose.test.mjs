import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-01 (AC-LEARN-01-01): 2 gap_id of same kind creates proposal with evidence[], expected_effect, revert in proposed status', () => {
    const risks = [
        { gap_id: 'gap-001', risk_kind: 'missing-evidence' },
        { gap_id: 'gap-002', risk_kind: 'missing-evidence' },
    ];

    const proposal = createProposal({
        project: 'baplatform',
        risk_kind: 'missing-evidence',
        risks,
        expected_effect: 'unsat_rate decreases and defect_rate does not increase',
        revert: {
            action: 'revert_rule',
            path: 'rules/req.md',
            previous_version: '1.0.0',
        },
    });

    assert.equal(proposal.project, 'baplatform');
    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.evidence.length, 2);
    assert.deepEqual(proposal.evidence, ['gap-001', 'gap-002']);
    assert.ok(proposal.expected_effect);
    assert.equal(proposal.revert.action, 'revert_rule');
    assert.equal(proposal.revert.path, 'rules/req.md');
});
