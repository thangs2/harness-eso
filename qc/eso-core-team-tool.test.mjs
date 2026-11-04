import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_7_ROLES,
    applyTeamPreset,
    deleteTeamRole,
    diffTeamPreset,
    declareToolConfig,
    verifyToolConnection,
    switchToolSource,
} from '../eso/core/src/index.mjs';

test('SCN-CFG-02-01 (AC-CFG-02-01 & AC-CFG-02-04 / ED1): Apply preset installs 7 roles, preserves custom roles without overwriting', () => {
    // 1. Clean project with 0 roles installs all 7 roles (AC-CFG-02-04 / ED1)
    const freshInstall = applyTeamPreset({
        project: 'clean-proj',
        currentRoles: [],
        presetRoles: DEFAULT_7_ROLES,
    });
    assert.equal(freshInstall.roles.length, 7);
    assert.deepEqual(freshInstall.skipped, []);

    // 2. Project with customized role skips custom role (AC-CFG-02-01)
    const customRoles = [
        { id: 'lead', name: 'Custom Lead', customized: true },
    ];

    const updatedInstall = applyTeamPreset({
        project: 'custom-proj',
        currentRoles: customRoles,
        presetRoles: DEFAULT_7_ROLES,
    });

    assert.deepEqual(updatedInstall.skipped, ['lead']);
    const leadRole = updatedInstall.roles.find((r) => r.id === 'lead');
    assert.equal(leadRole.name, 'Custom Lead');
    assert.equal(leadRole.customized, true);
    assert.equal(updatedInstall.roles.length, 7);
});

test('SCN-CFG-02-02 (AC-CFG-02-02): Deleting role assigned to active workers is rejected with ROLE_IN_USE', () => {
    const roles = [{ id: 'build' }, { id: 'verify' }];
    const workers = [
        { worker_id: 'w-1', role_id: 'build', state: 'active' },
        { worker_id: 'w-2', role_id: 'verify', state: 'retired' },
    ];

    // Attempt to delete 'build' (in use by w-1)
    assert.throws(() => {
        deleteTeamRole({
            project: 'baplatform',
            roleId: 'build',
            roles,
            workers,
        });
    }, (err) => {
        assert.equal(err.code, 'ROLE_IN_USE');
        assert.equal(err.role_id, 'build');
        assert.deepEqual(err.assigned_workers, ['w-1']);
        return true;
    });

    // Deleting 'verify' (only retired worker assigned) succeeds
    const deleted = deleteTeamRole({
        project: 'baplatform',
        roleId: 'verify',
        roles,
        workers,
    });
    assert.equal(deleted.success, true);
    assert.equal(deleted.roles.length, 1);
    assert.equal(deleted.roles[0].id, 'build');
});

test('SCN-CFG-02-03 (AC-CFG-02-03): diffTeamPreset shows diff without automatically applying changes', () => {
    const currentRoles = [
        { id: 'lead', name: 'Lead Architect', customized: true },
        { id: 'custom-sec', name: 'Security Engineer', customized: true },
    ];

    const diff = diffTeamPreset({
        currentRoles,
        presetRoles: DEFAULT_7_ROLES,
    });

    assert.equal(diff.has_diff, true);
    assert.equal(diff.is_applied, false);
    assert.equal(diff.customized_kept.length, 1);
    assert.equal(diff.customized_kept[0].id, 'lead');
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].id, 'custom-sec');
    assert.ok(diff.added.some((r) => r.id === 'build'));
});

test('SCN-CFG-02-05 (AC-CFG-02-05 / ED10): Worker pointing to missing/deleted role surfaces warning and is not auto-reassigned', () => {
    const workers = [
        { worker_id: 'worker-orphaned', role_id: 'deprecated-role', state: 'active' },
    ];

    const result = applyTeamPreset({
        project: 'baplatform',
        currentRoles: [],
        presetRoles: DEFAULT_7_ROLES,
        workers,
    });

    assert.deepEqual(result.missing_roles, ['deprecated-role']);
    const foundOrphanedRole = result.roles.find((r) => r.id === 'deprecated-role');
    assert.equal(foundOrphanedRole, undefined);
});

test('SCN-CFG-03-01 (AC-CFG-03-01 & AC-CFG-03-05 / ED9): Declare tool saves with unverified and verbatim URLs/keys', () => {
    const longProjectKey = 'VERY_LONG_ENTERPRISE_PROJECT_KEY_XYZ_99999';
    const unusualUrl = 'https://jira.corp.internal:8443/custom/subpath///api';

    const tool = declareToolConfig({
        project: 'baplatform',
        toolId: 'jira',
        toolConfig: {
            project_key: longProjectKey,
            base_url: unusualUrl,
        },
    });

    assert.equal(tool.status, 'unverified');
    assert.equal(tool.config.project_key, longProjectKey);
    assert.equal(tool.config.base_url, unusualUrl);
});

test('SCN-CFG-03-02 (AC-CFG-03-02): Connection check failure marks config with TOOL_UNREACHABLE without deleting config', () => {
    const toolConfig = { base_url: 'https://jira.example.com', token: 'expired-token' };

    const check = verifyToolConnection({
        project: 'baplatform',
        toolId: 'jira',
        toolConfig,
        testConnectionFn: () => {
            throw new Error('401 Unauthorized: token expired');
        },
    });

    assert.equal(check.record.status, 'TOOL_UNREACHABLE');
    assert.ok(check.record.error.includes('token expired'));
    assert.equal(check.record.config.token, 'expired-token');
});

test('SCN-CFG-03-03 (AC-CFG-03-03): Switching tool source preserves original imported pack sources', () => {
    const existingPacks = [
        { pack_id: 'pack-1', source: 'jira', data: {} },
        { pack_id: 'pack-2', source: 'jira', data: {} },
    ];

    const switched = switchToolSource({
        project: 'baplatform',
        targetSource: 'local',
        existingPacks,
    });

    assert.equal(switched.current_source, 'local');
    assert.equal(switched.packs[0].source, 'jira');
    assert.equal(switched.packs[1].source, 'jira');
});

test('SCN-CFG-03-04 (AC-CFG-03-04 / ED6): Verifying connection twice updates existing record without duplication', () => {
    const toolConfig = { base_url: 'https://jira.corp' };

    const firstRun = verifyToolConnection({
        project: 'baplatform',
        toolId: 'jira',
        toolConfig,
        testConnectionFn: () => true,
        existingConnections: [],
    });

    assert.equal(firstRun.all_connections.length, 1);
    assert.equal(firstRun.record.status, 'connected');

    // Second check update
    const secondRun = verifyToolConnection({
        project: 'baplatform',
        toolId: 'jira',
        toolConfig,
        testConnectionFn: () => true,
        existingConnections: firstRun.all_connections,
    });

    assert.equal(secondRun.all_connections.length, 1);
    assert.equal(secondRun.record.status, 'connected');
});
