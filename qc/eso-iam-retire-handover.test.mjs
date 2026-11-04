import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    handoverWorkerWork,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-25 (AC-IAM-07-01): Worker with pending tasks and recipient records handover and transfers ownership', () => {
    const worker = {
        worker_id: 'worker-retiring-bob',
        project: 'baplatform',
        state: 'active',
    };

    const tasks = [
        { task_id: 'task-100', what: 'Complete backend migration' },
    ];

    const result = handoverWorkerWork({
        worker,
        activeWork: tasks,
        recipient: 'worker-incoming-charlie',
    });

    assert.equal(result.state, 'retired');
    assert.ok(result.handover_record);
    assert.equal(result.handover_record.from_worker, 'worker-retiring-bob');
    assert.equal(result.handover_record.to_worker, 'worker-incoming-charlie');
    assert.equal(result.transferred_work.length, 1);
    assert.equal(result.transferred_work[0].owner, 'worker-incoming-charlie');
    assert.equal(result.transferred_work[0].previous_owner, 'worker-retiring-bob');
});
