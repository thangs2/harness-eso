import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createWorker,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-35 (AC-IAM-01-05 & ED6): Creating worker with existing ID halts with DUPLICATE_ID (only 1 worker exists)', () => {
    const existing = [
        { project: 'baplatform', worker_id: 'worker-dup-01', role_name: 'build-runtime', state: 'active' },
    ];

    assert.throws(() => {
        createWorker({
            project: 'baplatform',
            worker_id: 'worker-dup-01',
            role: 'build-runtime',
            existingWorkers: existing,
        });
    }, (err) => {
        assert.equal(err.code, 'DUPLICATE_ID');
        assert.equal(err.worker_id, 'worker-dup-01');
        return true;
    });
});
