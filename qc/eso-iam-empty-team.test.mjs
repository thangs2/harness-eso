import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listWorkers,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-34 (AC-IAM-01-04 & ED1): Querying team with 0 workers returns empty array without throwing error', () => {
    const emptyTeam = listWorkers({ workers: [], project: 'baplatform' });
    assert.deepEqual(emptyTeam, []);
    assert.equal(emptyTeam.length, 0);
});
