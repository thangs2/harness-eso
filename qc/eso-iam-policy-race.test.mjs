import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    savePolicy,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-38 (AC-IAM-03-05 & ED7): Two operators saving policy: stale version rejected with STALE_VERSION', () => {
    const currentPolicy = {
        policy_id: 'pol-race-check',
        version: 5,
        attribute: 'stage',
    };

    const staleEdit = {
        policy_id: 'pol-race-check',
        version: 4, // Stale version!
        attribute: 'stage',
    };

    assert.throws(() => {
        savePolicy({
            project: 'baplatform',
            policy: staleEdit,
            previousPolicy: currentPolicy,
            actor: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'STALE_VERSION');
        assert.equal(err.version, 4);
        assert.equal(err.current_version, 5);
        return true;
    });
});
