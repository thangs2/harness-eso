import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    retireWorker,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-02 (AC-IAM-01-02): Retiring active worker holding pending work routes tasks to OPEN risk with owner and review_by', () => {
    const worker = {
        project: 'baplatform',
        worker_id: 'worker-retire-01',
        role_name: 'build-runtime',
        harness_source: 'eso-native',
        state: 'active',
    };

    const activeWork = [
        { task_id: 'task-701', what: 'Complete slice S2 for QC test suite', owner: 'worker-retire-01' },
    ];

    const retired = retireWorker({
        worker,
        activeWork,
        reviewer: 'operator-lead',
    });

    assert.equal(retired.state, 'retired');
    assert.equal(retired.open_risks.length, 1);

    const risk = retired.open_risks[0];
    assert.equal(risk.status, 'OPEN');
    assert.equal(risk.review_by, 'operator-lead');
    assert.equal(risk.task_id, 'task-701');
    assert.equal(risk.project, 'baplatform');
});
