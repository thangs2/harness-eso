import test from 'node:test';
import assert from 'node:assert/strict';

import { BASIS_RANK, evaluateRoleSufficiency } from '../eso/iam/src/index.mjs';
import { executeHandover } from '../eso/control-plane/src/modules/flow/domain/flow.ts';

/**
 * ESO-387 / B9: the bar vocabulary must mean one thing across the tree.
 *
 * A role bar can name either IAM basis (unverified/partial/full/strict) or evidence basis
 * (assumption/heuristic/deterministic). The handover check in flow.ts already ranks both;
 * role sufficiency must agree, otherwise the same bar admits or rejects the same evidence
 * depending on which path evaluates it.
 */

const CASES = [
    { min_basis: 'deterministic', basis: 'assumption', sufficient: false },
    { min_basis: 'deterministic', basis: 'heuristic', sufficient: false },
    { min_basis: 'deterministic', basis: 'deterministic', sufficient: true },
    { min_basis: 'heuristic', basis: 'partial', sufficient: false },
    { min_basis: 'heuristic', basis: 'heuristic', sufficient: true },
    { min_basis: 'heuristic', basis: 'unverified', sufficient: false },
    { min_basis: 'full', basis: 'partial', sufficient: false },
    { min_basis: 'partial', basis: 'heuristic', sufficient: true },
    { min_basis: 'strict', basis: 'unverified', sufficient: false },
    { min_basis: 'strict', basis: 'strict', sufficient: true },
];

test('ESO-387: role sufficiency and flow handover agree on every bar/evidence pair', () => {
    for (const tc of CASES) {
        const role = { name: 'target', bar: [{ evidence_kind: 'test_pass', min_basis: tc.min_basis }] };
        const evidence = [{ evidence_kind: 'test_pass', basis: tc.basis }];

        const verdict = evaluateRoleSufficiency({ role, evidence });
        const sufficient = verdict.level === 'SUFFICIENT';

        let handoverAllowed = true;
        try {
            executeHandover({
                fromRole: 'source',
                toRole: 'target',
                targetRoleBar: role.bar,
                carries: evidence,
            });
        } catch (err) {
            assert.equal(err.code, 'HANDOFF_INCOMPLETE', `unexpected error for ${JSON.stringify(tc)}: ${err.message}`);
            handoverAllowed = false;
        }

        assert.equal(
            sufficient,
            tc.sufficient,
            `role sufficiency for min_basis=${tc.min_basis}, basis=${tc.basis}`
        );
        assert.equal(
            handoverAllowed,
            sufficient,
            `handover and role sufficiency must agree for min_basis=${tc.min_basis}, basis=${tc.basis}`
        );
    }
});

test('ESO-387: BASIS_RANK keeps both vocabularies on one scale and unknown keys do not outrank known ones', () => {
    assert.equal(BASIS_RANK.assumption, BASIS_RANK.partial);
    assert.equal(BASIS_RANK.heuristic, BASIS_RANK.full);
    assert.equal(BASIS_RANK.deterministic, BASIS_RANK.strict);
    assert.ok(BASIS_RANK.deterministic > BASIS_RANK.heuristic);
    assert.ok(BASIS_RANK.heuristic > BASIS_RANK.assumption);
    assert.equal(BASIS_RANK.unknown_basis, undefined);
});

test('ESO-387: a bar stated in evidence basis is not silently satisfied by weaker evidence', () => {
    // Before ESO-387 the IAM path only ranked {unverified,partial,full,strict}; a bar asking for
    // 'deterministic' ranked 0 and any carried evidence cleared it.
    const role = { name: 'verify', bar: [{ evidence_kind: 'test_pass', min_basis: 'deterministic' }] };

    const weak = evaluateRoleSufficiency({
        role,
        evidence: [{ evidence_kind: 'test_pass', basis: 'assumption' }],
    });
    assert.equal(weak.level, 'INSUFFICIENT');
    assert.equal(weak.deficits.length, 1);
    assert.equal(weak.deficits[0].reason, 'INSUFFICIENT_BASIS');
    assert.equal(weak.deficits[0].required_basis, 'deterministic');
    assert.equal(weak.deficits[0].actual_basis, 'assumption');

    const strong = evaluateRoleSufficiency({
        role,
        evidence: [{ evidence_kind: 'test_pass', basis: 'deterministic' }],
    });
    assert.equal(strong.level, 'SUFFICIENT');
    assert.deepEqual(strong.deficits, []);
});
