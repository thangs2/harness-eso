import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluatePolicies,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-08 (AC-IAM-03-01): Allow and deny rules both match -> deny wins (deny-overrides combining algorithm)', () => {
    const policies = [
        {
            policy_id: 'pol-allow-source',
            project: 'baplatform',
            attribute: 'harness_source',
            operator: 'eq',
            value: 'eso-native',
            effect: 'allow',
        },
        {
            policy_id: 'pol-deny-critical-path',
            project: 'baplatform',
            attribute: 'path',
            operator: 'starts_with',
            value: 'packages/core',
            effect: 'deny',
        },
    ];

    const target = {
        project: 'baplatform',
        harness_source: 'eso-native',
        path: 'packages/core/src/index.mjs',
    };

    const evaluation = evaluatePolicies({
        project: 'baplatform',
        target,
        policies,
    });

    assert.equal(evaluation.effect, 'deny');
    assert.equal(evaluation.decided_by, 'pol-deny-critical-path');
    assert.equal(evaluation.matched.length, 2);
    assert.ok(evaluation.matched.some((p) => p.policy_id === 'pol-allow-source'));
    assert.ok(evaluation.matched.some((p) => p.policy_id === 'pol-deny-critical-path'));
});
