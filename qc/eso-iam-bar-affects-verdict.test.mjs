import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateRoleSufficiency,
} from '../eso/iam/src/index.mjs';

test('SCN-IAM-06 (AC-IAM-02-03): Two roles with different bar yield different levels on same task differing on exact bar deficit', () => {
    const peerRole = {
        name: 'peer-dev',
        bar: [
            { evidence_kind: 'unit-test-log', min_basis: 'partial' },
        ],
    };

    const leadRole = {
        name: 'lead-architect',
        bar: [
            { evidence_kind: 'unit-test-log', min_basis: 'partial' },
            { evidence_kind: 'security-audit-report', min_basis: 'full' },
        ],
    };

    const taskEvidence = [
        { kind: 'unit-test-log', basis: 'partial' },
    ];

    const vPeer = evaluateRoleSufficiency({ role: peerRole, evidence: taskEvidence });
    const vLead = evaluateRoleSufficiency({ role: leadRole, evidence: taskEvidence });

    assert.equal(vPeer.level, 'SUFFICIENT');
    assert.equal(vLead.level, 'INSUFFICIENT');
    assert.equal(vLead.deficits.length, 1);
    assert.equal(vLead.deficits[0].evidence_kind, 'security-audit-report');
});
