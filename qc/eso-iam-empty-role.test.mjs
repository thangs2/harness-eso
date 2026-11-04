import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createRole,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-36 (AC-IAM-02-06 & ED1): Agent role without capabilities is rejected with EMPTY_ROLE (0 changes)', () => {
    assert.throws(() => {
        createRole({
            project: 'baplatform',
            name: 'agent-zero-cap',
            role_type: 'agent',
            capabilities: [],
            bar: [{ evidence_kind: 'test', min_basis: 'partial' }],
        });
    }, (err) => {
        assert.equal(err.code, 'EMPTY_ROLE');
        assert.match(err.message, /vai rỗng vô nghĩa/);
        return true;
    });
});
