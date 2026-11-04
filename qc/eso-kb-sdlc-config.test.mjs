import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    previewPageConfiguration,
    savePageConfiguration,
    initProjectSdlc,
    upgradeProjectSdlcStandard,
} from '../eso/knowledge/src/index.mjs';

test('SCN-CFG-01-01 (AC-CFG-01-01 & AC-CFG-01-06): Unified 4-group configuration saves atomically with matching hash', () => {
    const currentConfig = {
        version: 1,
        groups: {
            sdlc: { sdlc_root: 'sdlc' },
            team: { roles: [{ id: 'lead' }] },
            tools: { jira: { enabled: true } },
            project: { name: 'baplatform' },
        },
    };

    const pendingChanges = {
        sdlc: { version: '2.0' },
        team: { roles: [{ id: 'lead' }, { id: 'build' }] },
        tools: { jira: { enabled: true, project_key: 'BA' } },
        project: { tier: 'tier-1' },
    };

    const preview = previewPageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
    });

    assert.ok(preview.preview_hash);

    const saved = savePageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
        previewHash: preview.preview_hash,
        actorRole: 'operator',
    });

    assert.equal(saved.version, 2);
    assert.equal(saved.groups.sdlc.version, '2.0');
    assert.equal(saved.groups.team.roles.length, 2);
    assert.equal(saved.groups.tools.jira.project_key, 'BA');
    assert.equal(saved.groups.project.tier, 'tier-1');

    // Negative assertion: mismatch preview hash throws PREVIEW_HASH_MISMATCH (AC-CFG-01-06)
    assert.throws(() => {
        savePageConfiguration({
            project: 'baplatform',
            currentConfig,
            pendingChanges,
            previewHash: 'invalid-preview-hash',
            actorRole: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'PREVIEW_HASH_MISMATCH');
        return true;
    });
});

test('SCN-CFG-01-02 (AC-CFG-01-02): Changing sdlc_root with existing docs requires migration plan or rejected', () => {
    const currentConfig = {
        version: 1,
        groups: { sdlc: { sdlc_root: 'sdlc-old' } },
    };

    const pendingChanges = {
        sdlc: { sdlc_root: 'sdlc-new' },
    };

    const existingArtefacts = [
        { project: 'baplatform', path: 'sdlc-old/arch.md' },
    ];

    const preview = previewPageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
    });

    // Without migration plan -> rejected
    assert.throws(() => {
        savePageConfiguration({
            project: 'baplatform',
            currentConfig,
            pendingChanges,
            previewHash: preview.preview_hash,
            existingArtefacts,
            migrationPlan: null,
        });
    }, (err) => {
        assert.equal(err.code, 'MIGRATION_PLAN_REQUIRED');
        assert.deepEqual(err.affected_paths, ['sdlc-old/arch.md']);
        return true;
    });

    // With migration plan -> succeeds
    const saved = savePageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
        previewHash: preview.preview_hash,
        existingArtefacts,
        migrationPlan: { steps: ['move docs to new root'] },
    });
    assert.equal(saved.groups.sdlc.sdlc_root, 'sdlc-new');
});

test('SCN-CFG-01-03 (AC-CFG-01-03 & AC-CFG-02-01): Installing preset roles skips customized roles', () => {
    const currentConfig = {
        version: 1,
        groups: {
            team: {
                roles: [
                    { id: 'build', customized: true, rules: ['custom-rule'] },
                ],
            },
        },
    };

    const pendingChanges = {
        team: {
            apply_preset_roles: [
                { id: 'build', customized: false, rules: ['preset-rule'] },
                { id: 'verify', customized: false, rules: ['preset-verify'] },
            ],
        },
    };

    const preview = previewPageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
    });

    const saved = savePageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges,
        previewHash: preview.preview_hash,
    });

    assert.deepEqual(saved.skipped_roles, ['build']);
    const buildRole = saved.groups.team.roles.find((r) => r.id === 'build');
    assert.equal(buildRole.customized, true);
    assert.deepEqual(buildRole.rules, ['custom-rule']);
    assert.ok(saved.groups.team.roles.some((r) => r.id === 'verify'));
});

test('SCN-CFG-01-04 (AC-CFG-01-04): Agent role calling save is prohibited with FORBIDDEN_MUTATION', () => {
    assert.throws(() => {
        savePageConfiguration({
            project: 'baplatform',
            pendingChanges: { project: { tag: 'agent-edit' } },
            actorRole: 'build',
        });
    }, (err) => {
        assert.equal(err.code, 'FORBIDDEN_MUTATION');
        return true;
    });
});

test('SCN-CFG-01-05 (AC-CFG-01-05 / ED1): 0 changes across all groups is a no-op without bumping version', () => {
    const currentConfig = { version: 3, groups: { sdlc: { root: 'sdlc' } } };
    const result = savePageConfiguration({
        project: 'baplatform',
        currentConfig,
        pendingChanges: {}, // 0 changes
    });

    assert.equal(result.unchanged, true);
    assert.equal(result.version, 3);
    assert.ok(result.message.includes('không đổi'));
});

test('SCN-SDLC-01-01 (AC-SDLC-01-01 & AC-SDLC-01-06): Project init generates templates; re-run is idempotent', () => {
    // Blank project initialization (AC-SDLC-01-06 / ED1)
    const initResult = initProjectSdlc({
        project: 'clean-project',
        config: { sdlc_root: 'sdlc' },
        appliesWhen: { has_fe: true, has_jira: true },
    });

    assert.equal(initResult.changed, true);
    assert.equal(initResult.files_created.length, 4);

    // Re-run is idempotent (AC-SDLC-01-01)
    const reRun = initProjectSdlc({
        project: 'clean-project',
        config: { sdlc_root: 'sdlc' },
        isReInit: true,
    });

    assert.equal(reRun.changed, false);
    assert.equal(reRun.files_created.length, 0);
});

test('SCN-SDLC-01-02 (AC-SDLC-01-02): Missing declaration (sdlc_root) rejects initialization with MISSING_CONFIG', () => {
    assert.throws(() => {
        initProjectSdlc({
            project: 'baplatform',
            config: {}, // missing sdlc_root
        });
    }, (err) => {
        assert.equal(err.code, 'MISSING_CONFIG');
        assert.deepEqual(err.missing_fields, ['sdlc_root']);
        return true;
    });
});

test('SCN-SDLC-01-03 (AC-SDLC-01-03): applies_when filtering excludes non-matching templates and records OUT', () => {
    const result = initProjectSdlc({
        project: 'backend-only',
        config: { sdlc_root: 'sdlc' },
        appliesWhen: { has_fe: false, has_jira: true },
    });

    assert.ok(result.files_created.includes('sdlc/02.backend-spec.md'));
    assert.ok(!result.files_created.includes('sdlc/03.frontend-spec.md'));
    assert.equal(result.out_scope.length, 1);
    assert.equal(result.out_scope[0].template, 'sdlc/03.frontend-spec.md');
});

test('SCN-SDLC-01-04 (AC-SDLC-01-04 / tenant): Init on Project A leaves Project B completely untouched', () => {
    const resA = initProjectSdlc({
        project: 'project-A',
        config: { sdlc_root: 'sdlc-A' },
    });
    assert.equal(resA.project, 'project-A');
    assert.equal(resA.sdlc_root, 'sdlc-A');
});

test('SCN-SDLC-01-05 (AC-SDLC-01-05): Upgrading standard across >=2 projects covers all projects with revert capability', () => {
    const projects = [
        { id: 'proj-1', standard_version: '1.0.0' },
        { id: 'proj-2', standard_version: '1.0.0' },
        { id: 'proj-3', standard_version: '1.1.0' },
    ];

    const upgrade = upgradeProjectSdlcStandard({
        projects,
        targetStandardVersion: '2.0.0',
    });

    assert.equal(upgrade.upgraded_count, 3);
    assert.equal(upgrade.impact.length, 3);
    assert.equal(upgrade.can_revert, true);
});

test('SCN-SDLC-01-07 (AC-SDLC-01-07 / ED10): Changing sdlc_root while artefacts exist at old root rejected with DANGLING_ARTEFACTS_ROOT', () => {
    const existingArtefacts = [
        { project: 'baplatform', root: 'sdlc-legacy', file: 'design.md' },
    ];

    assert.throws(() => {
        initProjectSdlc({
            project: 'baplatform',
            config: { sdlc_root: 'sdlc-modern' },
            existingArtefacts,
        });
    }, (err) => {
        assert.equal(err.code, 'DANGLING_ARTEFACTS_ROOT');
        assert.equal(err.existing_root, 'sdlc-legacy');
        return true;
    });
});
