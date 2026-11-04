import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluatePolicies,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-53 (AC-IAM-03-07): Request targeting project outside authorized scope rejected with OUT_OF_SCOPE', () => {
    assert.throws(() => {
        evaluatePolicies({
            project: 'proj-allowed',
            target: { project: 'proj-foreign' },
            policies: [],
        });
    }, (err) => {
        assert.equal(err.code, 'OUT_OF_SCOPE');
        assert.equal(err.target_project, 'proj-foreign');
        return true;
    });
});
