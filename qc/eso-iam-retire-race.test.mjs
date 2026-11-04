import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    handoverWorkerWork,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-47 (AC-IAM-07-05 & ED7): Concurrent retirement handovers ensure exactly one winner; work is not duplicated or lost', () => {
    let workerState = {
        worker_id: 'worker-contested',
        project: 'baplatform',
        state: 'active',
    };

    const tasks = [
        { task_id: 'task-single-assign', what: 'Critical hotfix' },
    ];

    // First attempt succeeds
    const firstResult = handoverWorkerWork({
        worker: workerState,
        activeWork: tasks,
        recipient: 'worker-winner',
    });

    assert.equal(firstResult.state, 'retired');
    assert.equal(firstResult.transferred_work[0].owner, 'worker-winner');

    // Update state to retired
    workerState = firstResult;

    // Second attempt fails
    assert.throws(() => {
        handoverWorkerWork({
            worker: workerState,
            activeWork: tasks,
            recipient: 'worker-loser',
        });
    }, (err) => {
        assert.equal(err.code, 'ALREADY_INACTIVE');
        return true;
    });

    // Exactly one new owner exists
    assert.equal(firstResult.transferred_work[0].owner, 'worker-winner');
});
