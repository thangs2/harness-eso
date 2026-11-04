import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listProposals,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-05 (AC-LEARN-02-01): Opening proposal list presents evidence[], expected_effect, and revert for each entry', () => {
    const rawProposals = [
        {
            proposal_id: 'prop-review-1',
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            evidence: ['gap-101', 'gap-102'],
            expected_effect: 'unsat_rate decreases by 15%',
            revert: { action: 'delete_rule', path: 'rules/auth.md' },
            status: 'proposed',
        },
    ];

    const result = listProposals({ proposals: rawProposals, project: 'baplatform' });
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);

    const item = result.items[0];
    assert.deepEqual(item.evidence, ['gap-101', 'gap-102']);
    assert.equal(item.expected_effect, 'unsat_rate decreases by 15%');
    assert.equal(item.revert.action, 'delete_rule');
});
