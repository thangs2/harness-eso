import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluatePolicies,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-12 (AC-IAM-03-04): Policies of project A never apply to project B (0 matched policies recorded)', () => {
    const policies = [
        {
            policy_id: 'pol-proj-a',
            project: 'project-A',
            attribute: 'stage',
            operator: 'eq',
            value: 'prod',
            effect: 'deny',
        },
    ];

    const result = evaluatePolicies({
        project: 'project-B',
        target: { project: 'project-B', stage: 'prod' },
        policies,
    });

    assert.equal(result.matched.length, 0);
    assert.equal(result.reason, 'NO_MATCHING_POLICY');
    assert.equal(result.effect, 'deny');
});
