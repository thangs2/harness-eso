import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    handoverWorkerWork,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-46 (AC-IAM-07-04 & ED6): Retiring already retired/inactive worker rejected with ALREADY_INACTIVE (0 changes)', () => {
    const worker = {
        worker_id: 'worker-already-done',
        project: 'baplatform',
        state: 'retired',
    };

    assert.throws(() => {
        handoverWorkerWork({
            worker,
        });
    }, (err) => {
        assert.equal(err.code, 'ALREADY_INACTIVE');
        assert.equal(err.worker_id, 'worker-already-done');
        return true;
    });
});
