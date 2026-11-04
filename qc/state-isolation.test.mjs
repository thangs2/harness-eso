import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    applyHostProfiles,
    buildProvisionPlan,
} from '../packages/harness-foundation/src/project-registry.mjs';
import { initProfile } from '../packages/harness-foundation/src/init-profile.mjs';
import {
    PRODUCT_STATE_ENV,
    defaultProductStateDir,
    portableStatePath,
    productStateDir,
    registryFile,
    workspaceFile,
} from '../packages/harness-foundation/src/workspace-store.mjs';
import { migrateLegacyProductState } from '../packages/harness-cli/src/workspace-env.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');

function withEnv(overrides, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(overrides)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function tempConsumer() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-state-'));
}

// ---------------------------------------------------------------------------
// Product state lives in the operator's home
// ---------------------------------------------------------------------------

test('product state defaults to ~/.harness, never inside the checkout', () => {
    withEnv({ [PRODUCT_STATE_ENV]: undefined, HARNESS_PRODUCT_STATE_DIR: undefined }, () => {
        const dir = productStateDir();
        assert.equal(dir, defaultProductStateDir());
        assert.equal(dir, path.join(os.homedir(), '.harness'));
        // The whole point: the operator's project list must not move with the source tree.
        assert.ok(!dir.startsWith(ESO_ROOT), 'product state must not live in the product checkout');
        assert.ok(workspaceFile().startsWith(dir));
        assert.ok(registryFile().startsWith(dir));
    });
});

test('an explicit product state override still wins', () => {
    withEnv({ [PRODUCT_STATE_ENV]: '/tmp/custom-state' }, () => {
        assert.equal(productStateDir(), '/tmp/custom-state');
        assert.equal(workspaceFile(), '/tmp/custom-state/workspace.json');
    });
});

test('an empty override falls back to the default rather than resolving to ""', () => {
    // `productStateDir()` used to return '' when unset and callers had to set the env themselves.
    // One of those callers forced the checkout path, which is how this whole issue started.
    withEnv({ [PRODUCT_STATE_ENV]: '' }, () => {
        assert.equal(productStateDir(), defaultProductStateDir());
    });
});

test('portableStatePath collapses $HOME so consumer files carry no absolute host path', () => {
    const inside = path.join(os.homedir(), '.harness', 'registry.json');
    assert.equal(portableStatePath(inside), '~/.harness/registry.json');
    assert.equal(portableStatePath(os.homedir()), '~');
    // Outside the home directory there is nothing to collapse, so it is left alone.
    assert.equal(portableStatePath('/tmp/registry.json'), '/tmp/registry.json');
    assert.equal(portableStatePath('/opt/harness/registry.json'), '/opt/harness/registry.json');
    // A checkout under $HOME collapses too — which is exactly why the leak test below passes even
    // though this repo lives inside the operator's home directory. The synthetic path keeps the
    // assertion true wherever the checkout lives; a clone in /tmp or on a CI runner is still a clone.
    const underHome = path.join(os.homedir(), 'workspace', 'harness-eso');
    assert.equal(portableStatePath(underHome), '~/workspace/harness-eso');
    if (ESO_ROOT.startsWith(os.homedir() + path.sep)) {
        assert.equal(portableStatePath(ESO_ROOT), `~${ESO_ROOT.slice(os.homedir().length)}`);
    }
});

// ---------------------------------------------------------------------------
// What provisioning writes
// ---------------------------------------------------------------------------

function draftProject(root) {
    return {
        version: 1,
        id: 'state-qc',
        displayName: 'State QC',
        status: 'draft',
        agentRepo: { root },
        observe: { port: 8792 },
        hostMode: 'dual-ide',
        plugins: {},
    };
}

test('the provisioned consumer config carries no path to the product checkout', () => {
    const root = tempConsumer();
    const plan = buildProvisionPlan(draftProject(root), PROFILES_DIR, registryFile());
    const registry = plan.files.find((f) => f.relative === 'harness.config.json')?.preview?.registry?.registry;

    assert.equal(registry, '~/.harness/registry.json');
    assert.ok(!String(registry).includes(ESO_ROOT), 'must not embed the checkout path');
    assert.ok(!path.isAbsolute(registry), 'a committed file must not carry one machine home dir');
});

test('a consumer provisioned end to end has no absolute checkout path anywhere', () => {
    const root = tempConsumer();
    const project = draftProject(root);
    initProfile(project, PROFILES_DIR, registryFile(), { dryRun: false, verify: false });
    applyHostProfiles(root, buildProvisionPlan(project, PROFILES_DIR, registryFile()).hostProfiles, {
        observePort: 8792,
        verify: false,
    });

    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(p);
                continue;
            }
            if (fs.readFileSync(p, 'utf8').includes(ESO_ROOT)) offenders.push(path.relative(root, p));
        }
    };
    walk(root);
    assert.deepEqual(offenders, [], 'consumer state must not reference the product checkout');
});

// ---------------------------------------------------------------------------
// Migration of an install that predates the move
// ---------------------------------------------------------------------------

const LEGACY_DIR = path.join(ESO_ROOT, '.harness');
const LEGACY_WORKSPACE = path.join(LEGACY_DIR, 'workspace.json');

/**
 * Create the pre-move `<checkout>/.harness` tree the migration reads, and take it away again.
 *
 * It used to be whatever the machine happened to have on disk. `.harness/` is gitignored, so a
 * clean checkout has none and the test failed for the state of the machine rather than for the code
 * — while on an operator's machine it passed for the same wrong reason. The product hardcodes the
 * legacy location (`packages/harness-cli/src/workspace-env.mjs`), so the fixture has to be created
 * there; when real state already exists it is used as-is and never modified or removed.
 */
function withLegacyStateFixture(fn) {
    if (fs.existsSync(LEGACY_WORKSPACE)) return fn();
    const hadDir = fs.existsSync(LEGACY_DIR);
    fs.mkdirSync(LEGACY_DIR, { recursive: true });
    fs.writeFileSync(
        LEGACY_WORKSPACE,
        JSON.stringify({ version: 1, defaultProjectId: 'legacy-fixture', projects: [] }, null, 2),
    );
    try {
        return fn();
    } finally {
        fs.rmSync(LEGACY_WORKSPACE, { force: true });
        if (!hadDir) fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
    }
}

test('legacy product state is copied into ~/.harness once, and only once', () => {
    withLegacyStateFixture(() => {
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-newstate-'));
        try {
            const result = withEnv({ [PRODUCT_STATE_ENV]: dest }, () => migrateLegacyProductState());
            assert.ok(result, 'migration must report what it did');
            assert.equal(result.from, LEGACY_DIR);
            assert.equal(result.to, dest);
            assert.ok(result.copied.includes('workspace.json'), 'the legacy workspace file is what moves');
            assert.ok(fs.existsSync(path.join(dest, 'workspace.json')));

            // The source is left intact: an operator who downgrades still has it.
            assert.ok(fs.existsSync(LEGACY_WORKSPACE));

            // Second run is a no-op because the destination is now populated — it must not overwrite
            // state that may have moved on since.
            const second = withEnv({ [PRODUCT_STATE_ENV]: dest }, () => migrateLegacyProductState());
            assert.equal(second, null);
        } finally {
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

test('migration is skipped when the destination is the legacy directory itself', () => {
    withLegacyStateFixture(() => {
        const result = withEnv({ [PRODUCT_STATE_ENV]: LEGACY_DIR }, () => migrateLegacyProductState());
        assert.equal(result, null);
    });
});
