import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createWorker,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-01 (AC-IAM-01-01): Registering worker with role and project creates active worker with exactly one role', () => {
    const catalogRoles = [
        { name: 'build-runtime', status: 'current', project: 'baplatform' },
        { name: 'verify-runtime', status: 'current', project: 'baplatform' },
    ];

    const worker = createWorker({
        project: 'baplatform',
        worker_id: 'worker-build-01',
        role: 'build-runtime',
        harness_source: 'eso-native',
        catalogRoles,
    });

    assert.equal(worker.project, 'baplatform');
    assert.equal(worker.worker_id, 'worker-build-01');
    assert.equal(worker.role_name, 'build-runtime');
    assert.equal(worker.state, 'active');
    assert.equal(worker.harness_source, 'eso-native');
});
