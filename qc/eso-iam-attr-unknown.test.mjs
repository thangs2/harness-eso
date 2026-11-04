import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    savePolicy,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-11 (AC-IAM-03-03): Policy referencing non-existent attribute rejected at save time with UNKNOWN_ATTRIBUTE', () => {
    const policy = {
        policy_id: 'pol-bad-attr',
        attribute: 'arbitrary_custom_metric',
        operator: 'eq',
        value: '100',
        effect: 'deny',
    };

    assert.throws(() => {
        savePolicy({
            project: 'baplatform',
            policy,
            actor: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
        assert.equal(err.attribute, 'arbitrary_custom_metric');
        return true;
    });
});
