import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    changeWorkerRole,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-07 (AC-IAM-02-04): Agent actor attempting to change worker role is rejected with ROLE_CHANGE_FORBIDDEN (0 changes)', () => {
    const worker = {
        worker_id: 'worker-build-007',
        role_name: 'build',
    };

    assert.throws(() => {
        changeWorkerRole({
            worker,
            newRole: 'operator',
            actor: 'agent',
        });
    }, (err) => {
        assert.equal(err.code, 'ROLE_CHANGE_FORBIDDEN');
        assert.equal(err.actor, 'agent');
        return true;
    });

    assert.equal(worker.role_name, 'build');
});
