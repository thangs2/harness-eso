import test from 'node:test';
import assert from 'node:assert/strict';

import { executeHandover } from '../eso/control-plane/src/flow.mjs';
import { previewAttributeChange, saveAttributeChange } from '../eso/control-plane/src/config-mgr.mjs';
import { deleteTeamRole, applyTeamPreset } from '../eso/core/src/team-tool-cfg.mjs';

test('ESO-387 / B9: Flow handover with role.mjs bar shape ({ evidence_kind, min_basis })', () => {
    const targetRoleBar = [
        { evidence_kind: 'recon_pack', min_basis: 'heuristic' },
        { evidence_kind: 'test_pass', min_basis: 'deterministic' },
    ];

    // 1. Missing evidence -> HANDOFF_INCOMPLETE
    assert.throws(
        () => {
            executeHandover({
                fromRole: 'scout',
                toRole: 'plan',
                targetRoleBar,
                carries: [{ evidence_kind: 'recon_pack', basis: 'heuristic' }],
            });
        },
        (err) => {
            assert.equal(err.code, 'HANDOFF_INCOMPLETE');
            assert.equal(err.allowed, false);
            assert.deepEqual(err.missing, ['test_pass']);
            return true;
        }
    );

    // 2. Insufficient basis -> HANDOFF_INCOMPLETE
    assert.throws(
        () => {
            executeHandover({
                fromRole: 'scout',
                toRole: 'plan',
                targetRoleBar,
                carries: [
                    { evidence_kind: 'recon_pack', basis: 'heuristic' },
                    { evidence_kind: 'test_pass', basis: 'assumption' }, // assumption < deterministic
                ],
            });
        },
        (err) => {
            assert.equal(err.code, 'HANDOFF_INCOMPLETE');
            assert.match(err.missing[0], /min_basis: deterministic/);
            return true;
        }
    );

    // 3. Proper evidence carried (as objects) -> allowed without false blockage
    const res = executeHandover({
        fromRole: 'scout',
        toRole: 'plan',
        targetRoleBar,
        carries: [
            { evidence_kind: 'recon_pack', basis: 'heuristic' },
            { evidence_kind: 'test_pass', basis: 'deterministic' },
        ],
    });
    assert.equal(res.allowed, true);
    assert.equal(res.unconstrained, false);
    assert.equal(res.to, 'plan');

    // 4. Carried as string kinds also accepted
    const resStrings = executeHandover({
        fromRole: 'scout',
        toRole: 'plan',
        targetRoleBar,
        carries: ['recon_pack', 'test_pass'],
    });
    assert.equal(resStrings.allowed, true);
});

test('ESO-387 / B9: Config-mgr with policy.mjs shape (policy.attribute & target_attribute)', () => {
    const policies = [
        { id: 'pol-1', attribute: 'security_clearance', action: 'ALLOW' },
        { id: 'pol-2', target_attribute: 'network_zone', action: 'BLOCK' },
        { id: 'pol-3', uses: ['tenant_tier'] },
    ];

    // 1. Preview surfaces policies using policy.attribute
    const preview = previewAttributeChange({
        project: 'p1',
        attributeKey: 'security_clearance',
        action: 'delete',
        policies,
    });
    assert.equal(preview.affected_count, 1);
    assert.deepEqual(preview.affected_policies, ['pol-1']);

    // 2. Deleting attribute in use throws ATTRIBUTE_IN_USE
    assert.throws(
        () => {
            saveAttributeChange({
                project: 'p1',
                attributeKey: 'security_clearance',
                action: 'delete',
                policies,
                currentVersion: 1,
                requestedVersion: 1,
                actorRole: 'operator',
            });
        },
        (err) => {
            assert.equal(err.code, 'ATTRIBUTE_IN_USE');
            assert.deepEqual(err.used_by, ['pol-1']);
            return true;
        }
    );

    // 3. Renaming attribute in use without migration plan throws RENAME_WITHOUT_MIGRATION
    assert.throws(
        () => {
            saveAttributeChange({
                project: 'p1',
                attributeKey: 'network_zone',
                action: 'rename',
                newValue: 'nw_zone',
                policies,
                currentVersion: 1,
                requestedVersion: 1,
                actorRole: 'operator',
                hasMigrationPlan: false,
            });
        },
        (err) => {
            assert.equal(err.code, 'RENAME_WITHOUT_MIGRATION');
            assert.equal(err.attribute_key, 'network_zone');
            return true;
        }
    );

    // 4. Unused attribute deletion succeeds
    const successResult = saveAttributeChange({
        project: 'p1',
        attributeKey: 'unused_attr',
        action: 'delete',
        policies,
        currentVersion: 1,
        requestedVersion: 1,
        actorRole: 'operator',
    });
    assert.equal(successResult.success, true);
    assert.equal(successResult.version, 2);
});

test('ESO-387 / B9: Team role deletion with worker.mjs shape (role_name & role_id)', () => {
    const roles = [
        { id: 'architect', name: 'Lead Architect' },
        { id: 'scout', name: 'Recon Scout' },
    ];

    // Worker using role_name (worker.mjs shape)
    const workers = [
        { id: 'w-1', role_name: 'architect', state: 'active' },
        { id: 'w-2', role_name: 'scout', state: 'retired' }, // retired worker
    ];

    // 1. Deleting role in use by active worker throws ROLE_IN_USE (by id)
    assert.throws(
        () => {
            deleteTeamRole({
                project: 'p1',
                roleId: 'architect',
                roles,
                workers,
            });
        },
        (err) => {
            assert.equal(err.code, 'ROLE_IN_USE');
            assert.equal(err.role_id, 'architect');
            assert.deepEqual(err.assigned_workers, ['w-1']);
            return true;
        }
    );

    // 1b. Deleting role by name when worker has role_id or role_name throws ROLE_IN_USE
    assert.throws(
        () => {
            deleteTeamRole({
                project: 'p1',
                roleId: 'Lead Architect',
                roles,
                workers,
            });
        },
        (err) => {
            assert.equal(err.code, 'ROLE_IN_USE');
            assert.equal(err.role_id, 'Lead Architect');
            assert.deepEqual(err.assigned_workers, ['w-1']);
            return true;
        }
    );

    // 2. Retired worker does not block role deletion
    const delResult = deleteTeamRole({
        project: 'p1',
        roleId: 'scout',
        roles,
        workers,
    });
    assert.equal(delResult.success, true);
    assert.equal(delResult.deleted_role, 'scout');
    assert.equal(delResult.roles.length, 1);
});

test('ESO-387 / B9: Bar strict rejects unverified or partial', () => {
    const strictBar = [
        { evidence_kind: 'test_pass', min_basis: 'strict' },
    ];

    assert.throws(
        () => {
            executeHandover({
                fromRole: 'build',
                toRole: 'verify',
                targetRoleBar: strictBar,
                carries: [{ evidence_kind: 'test_pass', basis: 'unverified' }],
            });
        },
        (err) => {
            assert.equal(err.code, 'HANDOFF_INCOMPLETE');
            assert.match(err.missing[0], /min_basis: strict, got: unverified/);
            return true;
        }
    );

    const okResult = executeHandover({
        fromRole: 'build',
        toRole: 'verify',
        targetRoleBar: strictBar,
        carries: [{ evidence_kind: 'test_pass', basis: 'strict' }],
    });
    assert.equal(okResult.allowed, true);
});
