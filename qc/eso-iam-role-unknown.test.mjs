import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createWorker,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-03 (AC-IAM-01-03): Declaring worker with non-existent role halts with UNKNOWN_ROLE (0 workers created)', () => {
    const catalogRoles = [
        { name: 'build-runtime', status: 'current', project: 'baplatform' },
    ];

    assert.throws(() => {
        createWorker({
            project: 'baplatform',
            worker_id: 'worker-fail-role',
            role: 'invented-magic-role',
            catalogRoles,
        });
    }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ROLE');
        assert.equal(err.role, 'invented-magic-role');
        return true;
    });
});
