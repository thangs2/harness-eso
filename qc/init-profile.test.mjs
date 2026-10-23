import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initProfile, projectDraftForConsumer, reloadHostConfig } from '@mu/harness-foundation/init-profile';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');

test('init profile --plan lists dual-ide host files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-plan-'));
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-init' });
    const planned = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: true });
    const rels = planned.files.map((f) => f.relative);
    assert.ok(rels.includes('.cursor/hooks.json'));
    assert.ok(rels.includes('.agents/hooks.json'));
});

test('init profile apply writes tenant + host on consumer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-apply-'));
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-init-apply' });
    const applied = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        dryRun: false,
        // Only the install/merge bookkeeping is under test here; the pack self-check has its own
        // tests in qc/host-pack.test.mjs and costs ~0.7s per provision.
        verify: false,
    });
    assert.equal(applied.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'harness.config.json')));
    assert.ok(fs.existsSync(path.join(root, '.harness', 'decision-policy.json')));
    assert.ok(fs.existsSync(path.join(root, '.harness', 'host-pack', 'harness-hook.mjs')));
    assert.ok(fs.existsSync(path.join(root, '.harness', 'host-pack', 'host-pack.json')));

    // Consumer write gates must be provisioned
    assert.ok(fs.existsSync(path.join(root, '.cursor/hooks/guard-write.py')));
    assert.ok(fs.existsSync(path.join(root, '.cursor/hooks/guard-shell.py')));
    assert.ok(fs.existsSync(path.join(root, '.agents/hooks/guard-write.py')));
    assert.ok(fs.existsSync(path.join(root, '.agents/hooks/guard-shell.py')));
    assert.ok(fs.existsSync(path.join(root, '.agents/hooks/pre-tool-use.py')));

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8'));
    assert.ok(
        (cursorHooks.hooks.preToolUse || []).some(
            (e) => e.command === '.cursor/hooks/guard-write.py' && e.failClosed === true,
        ),
    );
    assert.ok(
        (cursorHooks.hooks.beforeShellExecution || []).some(
            (e) => e.command === '.cursor/hooks/guard-shell.py' && e.failClosed === true,
        ),
    );
});

test('init profile preserves operator edits to consumer guard scripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-preserve-'));
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-init-preserve' });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });

    const guardFile = path.join(root, '.cursor/hooks/guard-write.py');
    const customContent = '# operator custom write policy\nimport sys\n';
    fs.writeFileSync(guardFile, customContent, 'utf8');

    // Re-provisioning must not clobber operator edits
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });
    assert.equal(fs.readFileSync(guardFile, 'utf8'), customContent, 'operator customizations must survive provision');
});

test('reloadHostConfig rewrites host-bootstrap.json with a fresh appliedAt', { timeout: 15000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reload-'));
    /*
     * `sidecarUrl` depends on the machine's stack port, so it is recorded in the *ignored*
     * `sidecar.env`, never in the committed bootstrap: admitting a port into a shared file makes a
     * second developer's clone point at the first one's stack.
     */
    const project = { root, project: { id: 'qc-reload', hostMode: 'dual-ide' }, hostMode: 'dual-ide' };
    initProfile(projectDraftForConsumer(root, {
        hostMode: 'dual-ide',
        projectId: 'qc-reload',
    }), PROFILES_DIR, '/tmp/tenants.json', {
        dryRun: false,
        verify: false,
    });
    const bootstrapPath = path.join(root, '.harness', 'host-bootstrap.json');
    const before = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    assert.equal('sidecarUrl' in before, false, 'the port must not be in the committed file');

    // The profile CHANGED, which is when the record says a provision happened.
    const changed = projectDraftForConsumer(root, { hostMode: 'superset', hostProfile: 'cursor-superset', projectId: 'qc-reload' });
    await new Promise((r) => setTimeout(r, 5));
    const reloaded = reloadHostConfig(changed, PROFILES_DIR);
    assert.equal(reloaded.ok, true);

    const after = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    assert.notEqual(after.appliedAt, before.appliedAt);
    assert.ok(fs.existsSync(path.join(root, 'harness.config.json')));
});

test('re-provisioning the SAME profile does not rewrite appliedAt', { timeout: 15000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bootstrap-stable-'));
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-stable' });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });
    const bootstrapPath = path.join(root, '.harness', 'host-bootstrap.json');
    const before = fs.readFileSync(bootstrapPath, 'utf8');

    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });
    assert.equal(
        fs.readFileSync(bootstrapPath, 'utf8'),
        before,
        'an unchanged provision must not produce a diff in every developer tree',
    );
});

test('init profile --force rewrites a stale harness.config.json', { timeout: 15000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-force-'));
    const stale = {
        version: 1,
        project: { id: 'stale-id' },
        storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        ingest: { harnesses: [{ id: 'cursor', tree: '.cursor', shape: 'cursor', spineOptions: { transcriptDir: null } }] },
        tenancy: { mode: 'isolated', registry: '~/.harness/tenants.json' },
    };
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify(stale, null, 4));

    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-force' });
    const withoutForce = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        harnessEsoRoot: ESO_ROOT,
        dryRun: false,
    });
    assert.ok(
        withoutForce.files.some(
            (f) => f.relative === 'harness.config.json' && f.status === 'skipped',
        ),
    );
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8')).project.id,
        'stale-id',
    );

    const forced = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        harnessEsoRoot: ESO_ROOT,
        dryRun: false,
        force: true,
    });
    assert.ok(
        forced.files.some((f) => f.relative === 'harness.config.json' && f.status === 'updated'),
    );
    const after = JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8'));
    assert.equal(after.project.id, 'qc-force');
    assert.equal(after.tenancy.registry, '/tmp/tenants.json');
    // Dead legacy keys from the retired `configure add` path are gone.
    assert.equal(after.ingest.harnesses[0].spineOptions, undefined);
});

test('reloadHostConfig forceTenant rewrites the anchor; policy stays merge-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reload-tenant-'));
    const project = projectDraftForConsumer(root, {
        hostMode: 'dual-ide',
        projectId: 'qc-reload-tenant',
    });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        dryRun: false,
        verify: false,
    });

    // Two different edits, two different fates under merge:
    //   - a plan-defined key is re-applied from the wizard's choices;
    //   - a key the plan does not define survives (a forced rewrite would drop it).
    const policyPath = path.join(root, '.harness', 'decision-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    policy.jev = { ...(policy.jev || {}), mode: 'shadow' };
    policy.operatorTuning = { customThreshold: 0.42 };
    fs.writeFileSync(policyPath, JSON.stringify(policy, null, 4));
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'stale' } }, null, 4),
    );

    const res = reloadHostConfig(project, PROFILES_DIR, {
        harnessEsoRoot: ESO_ROOT,
        tenantsRegistryPath: '/tmp/tenants.json',
        forceTenant: true,
    });
    assert.equal(res.tenantRefreshed, true);
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8')).project.id,
        'qc-reload-tenant',
    );
    const after = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.equal(after.jev.mode, 'off');
    assert.equal(after.operatorTuning.customThreshold, 0.42);
});

test('reloadHostConfig without forceTenant leaves the anchor alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reload-host-only-'));
    const project = projectDraftForConsumer(root, {
        hostMode: 'dual-ide',
        projectId: 'qc-host-only',
    });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        dryRun: false,
        verify: false,
    });
    const stale = { version: 1, project: { id: 'stale' } };
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify(stale, null, 4));

    const res = reloadHostConfig(project, PROFILES_DIR);
    assert.equal(res.tenantRefreshed, false);
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8')).project.id,
        'stale',
    );
    // Host side still refreshed.
    assert.ok(res.bootstrap?.appliedAt);
});

test('init profile merges decision-policy when file already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-merge-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            eso: { enabled: true, preflight: { enabled: false } },
        }),
    );
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-init-merge' });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', {
        dryRun: false,
        verify: false,
    });
    const policy = JSON.parse(
        fs.readFileSync(path.join(root, '.harness', 'decision-policy.json'), 'utf8'),
    );
    assert.equal(policy.eso?.preflight?.enabled, true);
});

test('provisioned guard-write.py respects allowSessionStampFallback setting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guard-fallback-'));
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-fallback' });
    initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });

    const guardWritePath = path.join(root, '.cursor/hooks/guard-write.py');
    assert.ok(fs.existsSync(guardWritePath));

    const checkScript = `
import sys
import importlib.util
spec = importlib.util.spec_from_file_location('gw', '${guardWritePath}')
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)
assert gw.allow_session_stamp_fallback() is True
print("DEFAULT_TRUE")
`;
    const res1 = spawnSync('python3', ['-c', checkScript], { cwd: root, encoding: 'utf8' });
    assert.equal(res1.status, 0);
    assert.match(res1.stdout, /DEFAULT_TRUE/);

    // Disable via decision-policy.json
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({ version: 1, allowSessionStampFallback: false }),
    );
    const checkScriptFalse = `
import sys
import importlib.util
spec = importlib.util.spec_from_file_location('gw', '${guardWritePath}')
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)
assert gw.allow_session_stamp_fallback() is False
print("CONFIG_FALSE")
`;
    const res2 = spawnSync('python3', ['-c', checkScriptFalse], { cwd: root, encoding: 'utf8' });
    assert.equal(res2.status, 0);
    assert.match(res2.stdout, /CONFIG_FALSE/);

    // Disable via environment variable
    const checkScriptEnv = `
import sys
import importlib.util
spec = importlib.util.spec_from_file_location('gw', '${guardWritePath}')
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)
assert gw.allow_session_stamp_fallback() is False
print("ENV_FALSE")
`;
    const res3 = spawnSync('python3', ['-c', checkScriptEnv], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_ALLOW_SESSION_STAMP_FALLBACK: 'false' },
    });
    assert.equal(res3.status, 0);
    assert.match(res3.stdout, /ENV_FALSE/);
});

test('init profile dual-ide provisions Antigravity rules, core skills and session gitignore', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-antigravity-prov-'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');

    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-antigravity' });
    const res = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });

    assert.equal(res.ok, true);

    // Verify Antigravity law-gate rule (.md)
    assert.ok(fs.existsSync(path.join(root, '.agents/rules/core.law-gate.md')));
    assert.ok(fs.existsSync(path.join(root, '.cursor/rules/core.law-gate.mdc')));

    // Verify ESO core skills
    assert.ok(fs.existsSync(path.join(root, '.agents/skills/eso-recon/SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, '.agents/skills/eso-verify/SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, '.cursor/skills/eso-recon/SKILL.md')));

    // Verify root .gitignore contains session ignore
    const gitignoreContent = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.ok(gitignoreContent.includes('.agents/session/'));
    assert.ok(gitignoreContent.includes('.cursor/session/'));
});

test('init profile all-ide provisions triple-host parity across Cursor, Antigravity, and Claude Code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-all-ide-prov-'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');

    const project = projectDraftForConsumer(root, { hostMode: 'all-ide', projectId: 'qc-all-ide' });
    const res = initProfile(project, PROFILES_DIR, '/tmp/tenants.json', { dryRun: false, verify: false });

    assert.equal(res.ok, true);

    // 1. Cursor
    assert.ok(fs.existsSync(path.join(root, '.cursor/rules/core.law-gate.mdc')));
    assert.ok(fs.existsSync(path.join(root, '.cursor/skills/eso-recon/SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, '.cursor/hooks.json')));

    // 2. Antigravity
    assert.ok(fs.existsSync(path.join(root, '.agents/rules/core.law-gate.md')));
    assert.ok(fs.existsSync(path.join(root, '.agents/skills/eso-recon/SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, '.agents/hooks.json')));

    // 3. Claude Code
    assert.ok(fs.existsSync(path.join(root, '.claude/rules/core.law-gate.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude/skills/eso-recon/SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude/settings.json')));
    assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude/hooks/guard-write.py')));
    assert.ok(fs.existsSync(path.join(root, '.claude/hooks/guard-shell.py')));

    // 4. Gitignore contains all 3 session directories
    const gitignoreContent = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.ok(gitignoreContent.includes('.cursor/session/'));
    assert.ok(gitignoreContent.includes('.agents/session/'));
    assert.ok(gitignoreContent.includes('.claude/session/'));
});


