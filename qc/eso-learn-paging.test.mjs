import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listProposals,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-23 (AC-LEARN-02-05 & ED3): 500 proposals correctly paginated with total count and page chunks', () => {
    const rawProposals = [];
    for (let i = 0; i < 500; i++) {
        rawProposals.push({
            proposal_id: `prop-bulk-${i}`,
            evidence: [`gap-${i}`],
            expected_effect: `effect-${i}`,
            revert: { rollback: true },
        });
    }

    const pageSize = 25;
    const page3 = listProposals({ proposals: rawProposals, page: 3, pageSize });

    assert.equal(page3.total, 500);
    assert.equal(page3.totalPages, 20);
    assert.equal(page3.page, 3);
    assert.equal(page3.items.length, 25);
    assert.equal(page3.items[0].proposal_id, 'prop-bulk-50');
    assert.equal(page3.items[24].proposal_id, 'prop-bulk-74');
});
