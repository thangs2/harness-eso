import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listProposals,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-22 (AC-LEARN-02-04 & ED1): 0 proposals returns empty list without throwing errors', () => {
    const result = listProposals({ proposals: [] });
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.page, 1);
});
