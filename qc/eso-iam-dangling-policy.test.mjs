import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkRolePolicies,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-37 (AC-IAM-02-07 & ED10): Role pointing to deleted or non-existent policy surfaces DANGLING_POLICY', () => {
    const role = {
        name: 'release-lead',
        policies: ['policy-audit-gate', 'policy-deprecated-sec'],
    };

    const activePolicies = [
        { name: 'policy-audit-gate', status: 'current' },
        { name: 'policy-deprecated-sec', status: 'deleted' }, // Deleted!
    ];

    const result = checkRolePolicies({
        role,
        availablePolicies: activePolicies,
    });

    assert.equal(result.valid, false);
    assert.equal(result.code, 'DANGLING_POLICY');
    assert.deepEqual(result.dangling, ['policy-deprecated-sec']);
    assert.match(result.message, /DANGLING_POLICY/);
});
