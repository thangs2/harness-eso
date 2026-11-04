import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createRole,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-05 (AC-IAM-02-02): Agent role with empty bar obligation is rejected with EMPTY_OBLIGATION (0 roles created)', () => {
    assert.throws(() => {
        createRole({
            project: 'baplatform',
            name: 'unrestricted-build-agent',
            role_type: 'agent',
            capabilities: ['build'],
            bar: [], // Empty bar!
        });
    }, (err) => {
        assert.equal(err.code, 'EMPTY_OBLIGATION');
        assert.match(err.message, /empty bar obligations/);
        return true;
    });
});
