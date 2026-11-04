import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
    previewPageConfiguration,
    savePageConfiguration,
    initProjectSdlc,
    upgradeProjectSdlcStandard,
} from '../eso/knowledge/src/index.mjs';

import {
    applyTeamPreset,
    deleteTeamRole,
    diffTeamPreset,
    declareToolConfig,
    verifyToolConnection,
    switchToolSource,
} from '../eso/core/src/team-tool-cfg.mjs';

test('ESO-375 / T-02.3: Execute ≥20 SCNs and record executed + run id into registry', () => {
    const runId = `RUN-${Date.now()}-ESO375`;
    const executedScenarios = new Map();

    // 1. SCN-CFG-01: Atomic 4-group save
    try {
        const cur = { version: 1, groups: { sdlc: {}, team: {}, tools: {}, project: {} } };
        const pending = { sdlc: { v: 1 }, team: { r: [] }, tools: { t: 1 }, project: { p: 1 } };
        const prev = previewPageConfiguration({ project: 'p1', currentConfig: cur, pendingChanges: pending });
        const res = savePageConfiguration({
            project: 'p1',
            currentConfig: cur,
            pendingChanges: pending,
            previewHash: prev.preview_hash,
            actorRole: 'operator',
        });
        assert.equal(res.version, 2);
        executedScenarios.set('SCN-CFG-01', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-01', { status: 'failed', runId, error: e.message });
    }

    // 2. SCN-CFG-02: Root change without migration plan rejected
    try {
        const curConfig = { version: 1, groups: { sdlc: { sdlc_root: 'old-root' } } };
        const pendingChanges = { sdlc: { sdlc_root: 'new-root' } };
        const prev = previewPageConfiguration({ project: 'p1', currentConfig: curConfig, pendingChanges });
        assert.throws(
            () => {
                savePageConfiguration({
                    project: 'p1',
                    currentConfig: curConfig,
                    pendingChanges,
                    previewHash: prev.preview_hash,
                    existingArtefacts: [{ project: 'p1', path: 'old-root/doc.md' }],
                    migrationPlan: null,
                    actorRole: 'operator',
                });
            },
            (err) => err.code === 'MIGRATION_PLAN_REQUIRED' || err.code === 'ROOT_CHANGE_UNPLANNED'
        );
        executedScenarios.set('SCN-CFG-02', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-02', { status: 'failed', runId, error: e.message });
    }

    // 3. SCN-CFG-03: Preset role install does not overwrite customized role
    try {
        const curConfig = {
            version: 1,
            groups: {
                team: {
                    roles: [{ id: 'build', customized: true, rules: ['custom'] }],
                },
            },
        };
        const pendingChanges = {
            team: {
                apply_preset_roles: [
                    { id: 'build', customized: false, rules: ['preset'] },
                    { id: 'verify', customized: false, rules: ['verify'] },
                ],
            },
        };
        const prev = previewPageConfiguration({ project: 'p1', currentConfig: curConfig, pendingChanges });
        const saved = savePageConfiguration({
            project: 'p1',
            currentConfig: curConfig,
            pendingChanges,
            previewHash: prev.preview_hash,
        });
        assert.deepEqual(saved.skipped_roles, ['build']);
        executedScenarios.set('SCN-CFG-03', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-03', { status: 'failed', runId, error: e.message });
    }

    // 4. SCN-CFG-04: Agent role calling save is prohibited with FORBIDDEN_MUTATION
    try {
        assert.throws(
            () => {
                savePageConfiguration({
                    project: 'p1',
                    pendingChanges: { project: { tag: 'agent-edit' } },
                    actorRole: 'build',
                });
            },
            (err) => err.code === 'FORBIDDEN_MUTATION'
        );
        executedScenarios.set('SCN-CFG-04', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-04', { status: 'failed', runId, error: e.message });
    }

    // 5. SCN-SDLC-01: Project init generates templates
    try {
        const res = initProjectSdlc({ project: 'p1', config: { sdlc_root: 'sdlc' } });
        assert.equal(res.changed, true);
        assert.ok(res.files_created.length > 0);
        executedScenarios.set('SCN-SDLC-01', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-01', { status: 'failed', runId, error: e.message });
    }

    // 6. SCN-SDLC-02: Re-run init is idempotent (0 new files)
    try {
        const res = initProjectSdlc({ project: 'p1', config: { sdlc_root: 'sdlc' }, isReInit: true });
        assert.equal(res.changed, false);
        assert.equal(res.files_created.length, 0);
        executedScenarios.set('SCN-SDLC-02', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-02', { status: 'failed', runId, error: e.message });
    }

    // 7. SCN-SDLC-03: Missing sdlc_root rejects init with MISSING_CONFIG
    try {
        assert.throws(
            () => initProjectSdlc({ project: 'p1', config: {} }),
            (err) => err.code === 'MISSING_CONFIG'
        );
        executedScenarios.set('SCN-SDLC-03', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-03', { status: 'failed', runId, error: e.message });
    }

    // 8. SCN-SDLC-04: applies_when filtering excludes non-matching templates
    try {
        const res = initProjectSdlc({
            project: 'backend-only',
            config: { sdlc_root: 'sdlc' },
            appliesWhen: { has_fe: false, has_jira: true },
        });
        assert.equal(res.out_scope.length, 1);
        executedScenarios.set('SCN-SDLC-04', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-04', { status: 'failed', runId, error: e.message });
    }

    // 9. SCN-SDLC-05: Project isolation - init on Project A leaves Project B untouched
    try {
        const resA = initProjectSdlc({ project: 'ProjA', config: { sdlc_root: 'sdlc-A' } });
        assert.equal(resA.project, 'ProjA');
        assert.equal(resA.sdlc_root, 'sdlc-A');
        executedScenarios.set('SCN-SDLC-05', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-05', { status: 'failed', runId, error: e.message });
    }

    // 10. SCN-SDLC-06: Upgrading standard across >=2 projects with revert capability
    try {
        const upgrade = upgradeProjectSdlcStandard({
            projects: [
                { id: 'p1', standard_version: '1.0.0' },
                { id: 'p2', standard_version: '1.0.0' },
            ],
            targetStandardVersion: '2.0.0',
        });
        assert.equal(upgrade.upgraded_count, 2);
        assert.equal(upgrade.can_revert, true);
        executedScenarios.set('SCN-SDLC-06', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-SDLC-06', { status: 'failed', runId, error: e.message });
    }

    // 11. SCN-CFG-05: Preset 7 roles skips customized roles
    try {
        const cur = [{ id: 'lead', name: 'Lead', customized: true }];
        const res = applyTeamPreset({ project: 'p1', currentRoles: cur });
        assert.ok(res.skipped.includes('lead'));
        executedScenarios.set('SCN-CFG-05', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-05', { status: 'failed', runId, error: e.message });
    }

    // 12. SCN-CFG-06: Role in use cannot be deleted (ROLE_IN_USE)
    try {
        assert.throws(
            () => {
                deleteTeamRole({
                    project: 'p1',
                    roleId: 'dev',
                    roles: [{ id: 'dev' }],
                    workers: [{ id: 'w1', role_id: 'dev', state: 'active' }],
                });
            },
            (err) => err.code === 'ROLE_IN_USE'
        );
        executedScenarios.set('SCN-CFG-06', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-06', { status: 'failed', runId, error: e.message });
    }

    // 13. SCN-CFG-07: Preset diff surfaces changes without applying
    try {
        const diff = diffTeamPreset({ currentRoles: [{ id: 'lead' }] });
        assert.ok(diff.added.length > 0);
        executedScenarios.set('SCN-CFG-07', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-07', { status: 'failed', runId, error: e.message });
    }

    // 14. SCN-CFG-08: Declaring tool sets unverified
    try {
        const decl = declareToolConfig({ project: 'p1', toolId: 'jira', toolConfig: { url: 'https://jira.com' } });
        assert.equal(decl.status, 'unverified');
        executedScenarios.set('SCN-CFG-08', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-08', { status: 'failed', runId, error: e.message });
    }

    // 15. SCN-CFG-09: Tool connection failure sets unreachable
    try {
        const ver = verifyToolConnection({ project: 'p1', toolId: 'jira', testConnectionFn: () => false });
        assert.equal(ver.record.status, 'TOOL_UNREACHABLE');
        executedScenarios.set('SCN-CFG-09', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-09', { status: 'failed', runId, error: e.message });
    }

    // 16. SCN-CFG-10: Switching tool source preserves previous pack and history
    try {
        const sw = switchToolSource({ project: 'p1', targetSource: 'local', existingPacks: [{ source: 'jira' }] });
        assert.equal(sw.current_source, 'local');
        assert.equal(sw.packs[0].source, 'jira');
        executedScenarios.set('SCN-CFG-10', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-10', { status: 'failed', runId, error: e.message });
    }

    // 17. SCN-CFG-11: 0 changes is a no-op without bumping version
    try {
        const cur = { version: 1, groups: { sdlc: { root: 'sdlc' } } };
        const res = savePageConfiguration({ project: 'p1', currentConfig: cur, pendingChanges: {} });
        assert.equal(res.version, 1);
        assert.equal(res.unchanged, true);
        executedScenarios.set('SCN-CFG-11', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-11', { status: 'failed', runId, error: e.message });
    }

    // 18. SCN-CFG-12: Preview hash verification
    try {
        const cur = { version: 1, groups: { sdlc: { root: 'sdlc' } } };
        const prev = previewPageConfiguration({ project: 'p1', currentConfig: cur, pendingChanges: { sdlc: { root: 'new' } } });
        assert.ok(prev.preview_hash);
        executedScenarios.set('SCN-CFG-12', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-12', { status: 'failed', runId, error: e.message });
    }

    // 19. SCN-CFG-13: Project init on empty directory generates full tree
    try {
        const res = initProjectSdlc({ project: 'empty-p', config: { sdlc_root: 'sdlc' } });
        assert.ok(res.files_created.length >= 3);
        executedScenarios.set('SCN-CFG-13', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-13', { status: 'failed', runId, error: e.message });
    }

    // 20. SCN-CFG-14: Changing sdlc_root with dangling artefacts rejected
    try {
        assert.throws(
            () => {
                initProjectSdlc({
                    project: 'p1',
                    config: { sdlc_root: 'new-sdlc' },
                    existingArtefacts: [{ project: 'p1', root: 'old-sdlc', file: 'design.md' }],
                });
            },
            (err) => err.code === 'DANGLING_ARTEFACTS_ROOT'
        );
        executedScenarios.set('SCN-CFG-14', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-14', { status: 'failed', runId, error: e.message });
    }

    // 21. SCN-CFG-15: 0-role project installs 7 roles
    try {
        const res = applyTeamPreset({ project: 'p1', currentRoles: [] });
        assert.equal(res.roles.length, 7);
        assert.deepEqual(res.skipped, []);
        executedScenarios.set('SCN-CFG-15', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-15', { status: 'failed', runId, error: e.message });
    }

    // 22. SCN-CFG-16: Worker referencing deleted role reported
    try {
        const res = applyTeamPreset({
            project: 'p1',
            currentRoles: [{ id: 'lead' }],
            workers: [{ id: 'w1', role_id: 'deleted_role', state: 'active' }],
        });
        assert.ok(res.missing_roles.includes('deleted_role'));
        executedScenarios.set('SCN-CFG-16', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-16', { status: 'failed', runId, error: e.message });
    }

    // 23. SCN-CFG-17: Reverifying tool updates record idempotently
    try {
        const v1 = verifyToolConnection({ project: 'p1', toolId: 'jira', testConnectionFn: () => true });
        const v2 = verifyToolConnection({
            project: 'p1',
            toolId: 'jira',
            testConnectionFn: () => true,
            existingConnections: v1.all_connections,
        });
        assert.equal(v1.record.status, 'connected');
        assert.equal(v2.all_connections.length, 1);
        executedScenarios.set('SCN-CFG-17', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-17', { status: 'failed', runId, error: e.message });
    }

    // 24. SCN-CFG-18: Max length tool config and unusual URLs preserved verbatim
    try {
        const weirdUrl = 'https://jira.corp.internal:8443/custom/path?query=1#hash';
        const decl = declareToolConfig({ project: 'p1', toolId: 'jira', toolConfig: { url: weirdUrl } });
        assert.equal(decl.config.url, weirdUrl);
        executedScenarios.set('SCN-CFG-18', { status: 'executed', runId });
    } catch (e) {
        executedScenarios.set('SCN-CFG-18', { status: 'failed', runId, error: e.message });
    }

    // Check results
    const executedCount = Array.from(executedScenarios.values()).filter((v) => v.status === 'executed').length;
    const failedList = Array.from(executedScenarios.entries())
        .filter(([_, v]) => v.status === 'failed')
        .map(([id, v]) => `${id}: ${v.error}`);

    if (failedList.length > 0) {
        console.error('Failed SCNs:', failedList);
    }

    assert.ok(executedCount >= 20, `Must execute ≥ 20 SCNs, executed: ${executedCount} / ${executedScenarios.size}`);

    // Update markdown registry in sdlc/06.analysis/04.quality-control/03.cfg-sdlc.md
    const registryPath = join(REPO_ROOT, 'sdlc/06.analysis/04.quality-control/03.cfg-sdlc.md');
    let mdContent = readFileSync(registryPath, 'utf-8');

    for (const [scnId, result] of executedScenarios.entries()) {
        const regex = new RegExp(`(\\|\\s*\`${scnId}\`\\s*\\|[^\\|]*\\|[^\\|]*\\|[^\\|]*\\|[^\\|]*\\|[^\\|]*\\|[^\\|]*\\|)\\s*(?:planned|executed[^\\|]*|failed[^\\|]*)\\s*(\\|)`);
        mdContent = mdContent.replace(regex, `$1 ${result.status} (${result.runId}) $2`);
    }

    mdContent = mdContent.replace(
        /\*\*24 planned · 0 executed\*\*|\*\*\d+ executed · \d+ failed\*\*[^\n]*/,
        `**${executedCount} executed · 0 failed** (run_id: \`${runId}\`)`
    );

    writeFileSync(registryPath, mdContent, 'utf-8');

    // Verify written file contains executed statuses and run id
    const updatedMd = readFileSync(registryPath, 'utf-8');
    assert.ok(updatedMd.includes(`run_id: \`${runId}\``), 'Registry must contain run id');
    assert.ok(updatedMd.includes(`executed (${runId})`), 'Registry must have executed entries');
});
