import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    handoverWorkerWork,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-26 (AC-IAM-07-02): Worker with active work but no recipient and no OPEN risk flag rejected with RETIRE_WITH_WORK', () => {
    const worker = {
        worker_id: 'worker-blocked-retire',
        project: 'baplatform',
        state: 'active',
    };

    const tasks = [
        { task_id: 'task-auth-fix', what: 'Fix JWT expiration handling' },
    ];

    assert.throws(() => {
        handoverWorkerWork({
            worker,
            activeWork: tasks,
            recipient: null,
            allowOpenRisk: false,
        });
    }, (err) => {
        assert.equal(err.code, 'RETIRE_WITH_WORK');
        assert.equal(err.worker_id, 'worker-blocked-retire');
        assert.equal(err.work_count, 1);
        return true;
    });
});
