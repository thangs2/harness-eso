import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createRole,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-04 (AC-IAM-02-01): Open role creation accepts custom role name with capabilities, scope, and bar (evidence_kind + min_basis)', () => {
    const role = createRole({
        project: 'baplatform',
        name: 'solution-architect',
        version: 1,
        capabilities: ['arch-design', 'review'],
        scope: [
            { verb: 'read', kind: 'file', value: 'docs/**' },
            { verb: 'write', kind: 'file', value: 'docs/architecture/**' },
        ],
        bar: [
            { evidence_kind: 'diagram-schema', min_basis: 'full' },
        ],
    });

    assert.equal(role.name, 'solution-architect');
    assert.deepEqual(role.capabilities, ['arch-design', 'review']);
    assert.equal(role.scope.length, 2);
    assert.equal(role.bar[0].evidence_kind, 'diagram-schema');
    assert.equal(role.bar[0].min_basis, 'full');
});
