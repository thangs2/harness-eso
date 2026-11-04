import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    savePolicy,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-09 & SCN-IAM-10 (AC-IAM-03-02): Agent modifying policy directly or indirectly is rejected with POLICY_CHANGE_FORBIDDEN', () => {
    const policy = {
        policy_id: 'pol-custom-guard',
        attribute: 'stage',
        operator: 'eq',
        value: 'prod',
        effect: 'deny',
    };

    // 1. Direct agent attempt (SCN-IAM-09)
    assert.throws(() => {
        savePolicy({
            project: 'baplatform',
            policy,
            actor: 'agent',
            channel: 'direct',
        });
    }, (err) => {
        assert.equal(err.code, 'POLICY_CHANGE_FORBIDDEN');
        assert.equal(err.channel, 'direct');
        return true;
    });

    // 2. Indirect agent attempt via delegation (SCN-IAM-10)
    assert.throws(() => {
        savePolicy({
            project: 'baplatform',
            policy,
            actor: 'subagent-peer',
            channel: 'indirect',
        });
    }, (err) => {
        assert.equal(err.code, 'POLICY_CHANGE_FORBIDDEN');
        assert.equal(err.channel, 'indirect');
        return true;
    });
});
