import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkFlowDanglingWorkers,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-27 (AC-IAM-07-03): Active flow referencing retired worker surfaces DANGLING_FLOW (not silently ignored)', () => {
    const workers = [
        { worker_id: 'worker-lead', state: 'active' },
        { worker_id: 'worker-retired-peer', state: 'retired' },
    ];

    const flow = {
        name: 'eso-pipeline',
        steps: [
            { id: 'scout-step', worker_id: 'worker-lead' },
            { id: 'build-step', worker_id: 'worker-retired-peer' },
        ],
    };

    const evaluation = checkFlowDanglingWorkers({ flow, workers });
    assert.equal(evaluation.valid, false);
    assert.equal(evaluation.code, 'DANGLING_FLOW');
    assert.equal(evaluation.dangling_workers.length, 1);
    assert.equal(evaluation.dangling_workers[0].worker_id, 'worker-retired-peer');
});
