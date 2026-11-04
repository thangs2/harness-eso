import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createRole,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-24 (AC-IAM-02-05): Role scope with verb outside closed set is rejected with UNKNOWN_VERB', () => {
    assert.throws(() => {
        createRole({
            project: 'baplatform',
            name: 'ops-worker',
            capabilities: ['deploy'],
            bar: [{ evidence_kind: 'approval-token', min_basis: 'strict' }],
            scope: [
                { verb: 'force_push_master', kind: 'file', value: '*' },
            ],
        });
    }, (err) => {
        assert.equal(err.code, 'UNKNOWN_VERB');
        assert.equal(err.verb, 'force_push_master');
        return true;
    });
});
