import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyHostProfiles, installHostPack, loadHostProfile } from '../packages/harness-foundation/src/host-install.mjs';

/**
 * Antigravity runs command hooks with cwd set to the tree dir, not the consumer root.
 *
 * Measured, not assumed. `<consumer>/.agents/hooks.json` holds
 *
 *     node ../.harness/host-pack/harness-hook.mjs --hook route --tree agents --event PreToolUse
 *
 * and the host resolves it against `.agents/`:
 *
 *     command_hook_executor.go  →  Cannot find module '<repo>/.agents/.harness/host-pack/harness-hook.mjs'
 *     node:internal/modules/cjs/loader  →  exit status 1  →  "every tool call blocked"
 *
 * (IDE log `~/.gemini/antigravity/log/cli-*.log`, 2026-10-28.)
 *
 * What broke before: the commands carried `bash -lc '[ -f harness.config.json ] || cd ..; exec …'`,
 * which normalised the cwd — and also exited 127 on Windows, so 80d9c90 replaced it with a bare
 * `node .harness/…` literal. `bash` was the bug; the `cd ..` was load-bearing, and nothing replaced
 * it, so every `.agents` hook resolved a doubled path (`<repo>/.agents/.agents/…`).
 *
 * The rule this file pins:
 *
 *   1. every `.agents` hook command names the pack with a path relative to `.agents/`;
 *   2. each of those commands actually decides when spawned from `.agents/`, with no shell wrapper
 *      beyond the one the host itself uses;
 *   3. the root-relative spelling is kept as a negative control — if it ever starts working from
 *      `.agents/`, the host changed and this file should be revisited rather than silently trusted.
 */

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');
const PACK_DIR = path.join(ESO_ROOT, 'packages', 'harness-host-generic', 'dist', 'host-pack');

function tempConsumer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agy-cwd-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ version: 1, project: { id: 'agy-cwd' } }));
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'observe' },
        }),
    );
    return root;
}

/** Provision the Antigravity tree exactly the way `provision` does, pack included. */
function provisionAgentsTree() {
    const root = tempConsumer();
    installHostPack(root);
    applyHostProfiles(root, [loadHostProfile(PROFILES_DIR, 'agents-superset')], { observePort: 8792, verify: false });
    return root;
}

/** Every `command` literal in `.agents/hooks.json`, whatever shape its entry has. */
function agentsCommands(root) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'));
    const out = [];
    const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (typeof node.command === 'string') out.push(node.command);
        Object.values(node).forEach(walk);
    };
    walk(doc);
    return out;
}

/** Run a hook the way the host does: a shell command, cwd = `<consumer>/.agents`, payload on stdin. */
function runFromTree(root, command, event) {
    const res = spawnSync(command, {
        shell: true,
        cwd: path.join(root, '.agents'),
        encoding: 'utf8',
        input: `{"userPrompt":"probe","toolCall":{"name":"run_command","arguments":{"CommandLine":"ls"}}}\n`,
        timeout: 60_000,
        env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: root },
    });
    const stdout = String(res.stdout || '').trim();
    const last = stdout ? stdout.split('\n').filter(Boolean).pop() : '';
    return { status: res.status, stdout, stderr: String(res.stderr || ''), json: last ? safeJson(last) : null, event };
}

function safeJson(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function pythonAvailable() {
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    return probe.status === 0;
}

test('every .agents hook names the pack relative to the tree dir, and no shell', () => {
    const root = provisionAgentsTree();
    try {
        const commands = agentsCommands(root).filter((c) => c.includes('harness-hook.mjs'));
        assert.ok(commands.length >= 8, `expected the Antigravity superset, found ${commands.length} pack commands`);

        const wrong = commands.filter((c) => !c.startsWith('node ../.harness/host-pack/harness-hook.mjs '));
        assert.deepEqual(
            wrong,
            [],
            'Antigravity resolves hook paths against .agents/, so the pack must be named relative to it',
        );

        const shells = agentsCommands(root).filter((c) => /(^|\s)(bash|sh|zsh)\s/.test(c));
        assert.deepEqual(shells, [], 'a shell here would exit 127 on Windows and block the turn when failClosed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the managed tracer hook resolves from .agents/', { skip: !pythonAvailable() && 'python3 is not installed' }, () => {
    const root = provisionAgentsTree();
    try {
        const tracer = agentsCommands(root).find((c) => c.includes('pre-tool-use.py'));
        assert.equal(tracer, 'python3 hooks/pre-tool-use.py', 'the tracer path is resolved against .agents/ too');

        const res = runFromTree(root, tracer, 'PreToolUse');
        assert.equal(res.status, 0, `tracer exited ${res.status}: ${res.stderr.slice(0, 300)}`);
        assert.equal(typeof res.json, 'object', `tracer emitted no JSON decision: ${res.stdout.slice(0, 200)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('every .agents hook decides when spawned from .agents/ (the measured host cwd)', { skip: !fs.existsSync(path.join(PACK_DIR, 'harness-hook.mjs')) && 'host pack is not built' }, () => {
    const root = provisionAgentsTree();
    try {
        const failures = [];
        for (const command of agentsCommands(root).filter((c) => c.includes('harness-hook.mjs'))) {
            const res = runFromTree(root, command, 'probe');
            if (res.status !== 0) {
                failures.push(`${command}\n  exit ${res.status}: ${res.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
                continue;
            }
            // Antigravity reads a JSON decision on stdout; `{}` is legal for PostToolUse/Stop.
            if (!res.json) failures.push(`${command}\n  no JSON on stdout: ${res.stdout.slice(0, 200)}`);
        }
        assert.deepEqual(failures, [], 'a hook that cannot decide from .agents/ blocks every tool call');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('negative control: the root-relative spelling cannot resolve from .agents/', { skip: !fs.existsSync(path.join(PACK_DIR, 'harness-hook.mjs')) && 'host pack is not built' }, () => {
    const root = provisionAgentsTree();
    try {
        const res = runFromTree(root, 'node .harness/host-pack/harness-hook.mjs --hook route --tree agents --event PreToolUse', 'PreToolUse');
        assert.notEqual(res.status, 0, 'if this now succeeds, the host cwd changed — re-measure and update the profile');
        assert.match(res.stderr, /Cannot find module|MODULE_NOT_FOUND/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('re-provisioning a consumer that still carries the root-relative form converges', () => {
    /*
     * Consumers provisioned by 80d9c90 already have the broken spelling on disk (`x79`, `FinESO`,
     * `atrievefin` did when this was written). A profile change that only helps a fresh clone would
     * leave every existing Antigravity install blocked, so the merge has to re-point them.
     *
     * The fixture rewrites **both** the config and the recorded state, because that is what such a
     * consumer looks like: the command on disk is exactly the one we recorded writing. Rewriting only
     * the config would look like an operator edit, which the merge is right to preserve.
     */
    const root = provisionAgentsTree();
    try {
        const hooksPath = path.join(root, '.agents', 'hooks.json');
        const statePath = path.join(root, '.harness', 'host-install-state.json');
        for (const file of [hooksPath, statePath]) {
            const legacy = fs
                .readFileSync(file, 'utf8')
                .split('node ../.harness/host-pack/harness-hook.mjs')
                .join('node .harness/host-pack/harness-hook.mjs');
            fs.writeFileSync(file, legacy);
        }
        assert.ok(agentsCommands(root).some((c) => c.startsWith('node .harness/')), 'fixture must start from the broken spelling');

        applyHostProfiles(root, [loadHostProfile(PROFILES_DIR, 'agents-superset')], { observePort: 8792, verify: false });

        const packCommands = agentsCommands(root).filter((c) => c.includes('harness-hook.mjs'));
        assert.ok(packCommands.length >= 8, 'the merge must not drop the hooks it is re-pointing');
        const stale = packCommands.filter((c) => !c.startsWith('node ../.harness/'));
        assert.deepEqual(stale, [], 'a re-provision must rewrite the old spelling, not keep it');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
