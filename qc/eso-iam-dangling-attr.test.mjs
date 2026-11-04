import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluatePolicies,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-39 (AC-IAM-03-06 & ED10): Policy pointing to deleted attribute surfaces DANGLING_ATTRIBUTE and does not match', () => {
    const policy = {
        policy_id: 'pol-deleted-attr-target',
        project: 'baplatform',
        attribute: 'legacy_attr',
        operator: 'eq',
        value: 'old_val',
        effect: 'deny',
    };

    const result = evaluatePolicies({
        project: 'baplatform',
        target: { project: 'baplatform', legacy_attr: 'old_val' },
        policies: [policy],
        availableAttributes: ['project', 'path', 'stage'], // legacy_attr deleted!
    });

    assert.equal(result.matched.length, 0);
    assert.equal(result.dangling_attributes.length, 1);
    assert.equal(result.dangling_attributes[0].code, 'DANGLING_ATTRIBUTE');
    assert.equal(result.dangling_attributes[0].attribute, 'legacy_attr');
});
