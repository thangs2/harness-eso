import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hookNameFromCommand } from '../packages/harness-foundation/src/hook-merge.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    addHostProfile,
    applyHostProfiles,
    hostPackStatus,
    installHostPack,
    loadHostProfile,
    removeHostTree,
    verifyHostPack,
} from '../packages/harness-foundation/src/host-install.mjs';
import { buildHostPack, externalImports, PACK_FILES } from '../scripts/build-host-pack.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.join(ESO_ROOT, 'packages/harness-host-generic/dist/host-pack');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');

function tempConsumer() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pack-'));
}

function writeConsumerConfig(root, policy = {}) {
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'isolated' } }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: 'observe',
                cognition: { enforceBrain: 'fail_closed', gapAttestation: true },
            },
            ...policy,
        }),
    );
}

function runPack(root, hook, stdinObj, extraArgs = []) {
    const entry = path.join(root, '.harness/host-pack/harness-hook.mjs');
    const proc = spawnSync('node', [entry, '--hook', hook, '--tree', 'cursor', ...extraArgs], {
        input: stdinObj ? `${JSON.stringify(stdinObj)}\n` : '',
        encoding: 'utf8',
        cwd: root,
        // No HARNESS_ESO_ROOT, no NODE_PATH: the pack must resolve everything itself.
        env: { ...process.env, HARNESS_TREE: 'cursor' },
    });
    const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    return { json: line ? JSON.parse(line) : {}, stderr: proc.stderr, status: proc.status };
}

test('pack builds with zero imports outside node builtins', async () => {
    const { manifest } = await buildHostPack();
    assert.ok(manifest.version, 'manifest must carry a version');
    const bundle = fs.readFileSync(path.join(PACK_DIR, manifest.entry), 'utf8');
    const external = externalImports(bundle);
    assert.deepEqual(
        external,
        [],
        `bundle must not reference anything but node:* — found: ${external.join(', ')}`,
    );
});

test('externalImports catches @mu specifiers and bare packages', () => {
    assert.deepEqual(externalImports("import x from '@mu/harness-foundation';"), ['@mu/harness-foundation']);
    assert.deepEqual(externalImports("import x from 'left-pad';"), ['left-pad']);
    assert.deepEqual(externalImports('const x = await import("bun:sqlite");'), ['bun:sqlite']);
    // Builtins and relative paths are the only things allowed through.
    assert.deepEqual(externalImports("import fs from 'node:fs';\nimport y from './local.mjs';"), []);
});

test('install copies every manifest file and verifies its checksum', () => {
    const root = tempConsumer();
    const { manifest, actions } = installHostPack(root);
    for (const name of Object.keys(manifest.files)) {
        assert.ok(fs.existsSync(path.join(root, '.harness/host-pack', name)), `${name} not installed`);
    }
    assert.ok(fs.existsSync(path.join(root, '.harness/host-pack/host-pack.json')));
    assert.ok(actions.length >= PACK_FILES.length);
});

test('install refuses a pack whose checksum does not match the manifest', () => {
    const root = tempConsumer();
    const saved = fs.readFileSync(path.join(PACK_DIR, 'route-hook.py'));
    try {
        // Corrupt the source pack, then restore. A truncated install would leave hooks that throw
        // on every tool call, and guards fail closed — so a bad pack must fail the provision.
        fs.writeFileSync(path.join(PACK_DIR, 'route-hook.py'), `${saved}\n# tampered\n`);
        assert.throws(() => installHostPack(root), /checksum mismatch/);
    } finally {
        fs.writeFileSync(path.join(PACK_DIR, 'route-hook.py'), saved);
    }
});

test('installed consumer references the product checkout nowhere', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);

    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(p);
                continue;
            }
            const text = fs.readFileSync(p, 'utf8');
            if (text.includes(ESO_ROOT)) offenders.push(path.relative(root, p));
        }
    };
    walk(path.join(root, '.harness/host-pack'));
    assert.deepEqual(offenders, [], 'host pack must not embed a path back to harness-eso');
});

test('installed pack runs a guard with no node_modules and no HARNESS_ESO_ROOT', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);

    // Nothing resolves packages here, so a hook that still imported @mu/… would throw. The guard
    // posture is fail-closed, so an import failure would show up as a deny rather than a crash.
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);

    const allow = runPack(root, 'guard-shell', { command: 'bun test' });
    assert.equal(allow.json.permission, 'allow');

    const deny = runPack(root, 'guard-shell', {
        command: 'psql -c "DROP DATABASE prod"',
    });
    assert.equal(deny.json.permission, 'deny');
});

test('dispatcher inside the installed pack denies an unknown hook', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    const { json } = runPack(root, 'nope', { command: 'ls' });
    assert.equal(json.permission, 'deny');
    assert.match(json.user_message, /unknown hook/);
});

test('route helper ships next to the bundle so it resolves pack-relative', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    assert.ok(fs.existsSync(path.join(root, '.harness/host-pack/route-hook.py')));
    assert.ok(fs.existsSync(path.join(root, '.agents/session')) === false);
    // `--tree agents` must still find the helper: resolution is relative to the bundle, not cwd.
    const proc = spawnSync(
        'node',
        [path.join(root, '.harness/host-pack/harness-hook.mjs'), '--hook', 'route', '--tree', 'agents', '--event', 'PreInvocation'],
        {
            input: '{}\n',
            encoding: 'utf8',
            cwd: root,
            env: { ...process.env, HARNESS_TREE: 'agents' },
        },
    );
    const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    assert.ok(line, 'route hook must emit a decision');
});

test('provision writes dispatcher commands and no per-IDE hook copies', () => {
    const root = tempConsumer();
    const profiles = [
        loadHostProfile(PROFILES_DIR, 'cursor-superset'),
        loadHostProfile(PROFILES_DIR, 'agents-superset'),
    ];
    applyHostProfiles(root, profiles, { observePort: 8792, verify: false });

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8'));
    const commands = JSON.stringify(cursorHooks);
    assert.match(commands, /\.harness\/host-pack\/harness-hook\.mjs --hook preflight/);
    assert.match(commands, /\.harness\/host-pack\/harness-hook\.mjs --hook guard-shell/);
    /*
     * `guard-write` is deliberately NOT wired.
     *
     * It gates by evidence, not by path: with the posture resolving to `fail_closed` (which is what
     * an unrecognised policy value resolves to) it denies **every** write, including `src/x.mjs`, for
     * as long as the turn's sufficiency is below threshold. The consumer's own `guard-write.py` already
     * applies the evidence gate to the paths that actually need it — it reads the same ESO stamp and
     * scopes by `PROTECTED_PREFIXES`. So wiring the pack's copy adds no protection and freezes all
     * editing. See F26.
     */
    assert.ok(
        !commands.includes('--hook guard-write'),
        'the unscoped evidence gate must not be wired — see F26',
    );
    // The whole point: no HARNESS_ESO_ROOT anywhere in the consumer's hook wiring.
    assert.ok(!commands.includes('HARNESS_ESO_ROOT'), 'hook commands must not carry HARNESS_ESO_ROOT');
    assert.ok(!commands.includes('harness-eso'), 'hook commands must not name the product checkout');

    // Neither IDE tree carries a copy of the implementation any more.
    assert.equal(fs.existsSync(path.join(root, '.cursor/hooks/harness-eso')), false);
    assert.equal(fs.existsSync(path.join(root, '.agents/hooks/harness-eso')), false);

    // And sidecar.env no longer leaks a checkout path.
    const sidecarEnv = fs.readFileSync(path.join(root, '.harness/sidecar.env'), 'utf8');
    assert.ok(!sidecarEnv.includes('HARNESS_ESO_ROOT'), 'sidecar.env must not carry HARNESS_ESO_ROOT');
    assert.match(sidecarEnv, /HARNESS_REPO_ROOT=/);
});

test('re-running provision is idempotent for hooks.json', () => {
    const root = tempConsumer();
    const profiles = [
        loadHostProfile(PROFILES_DIR, 'cursor-superset'),
        loadHostProfile(PROFILES_DIR, 'agents-superset'),
    ];
    applyHostProfiles(root, profiles, { observePort: 8792, verify: false });
    const first = fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8');
    applyHostProfiles(root, profiles, { observePort: 8792, verify: false });
    applyHostProfiles(root, profiles, { observePort: 8792, verify: false });
    const third = fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8');
    assert.equal(third, first, 're-provisioning must not append duplicate hook entries');
});

// ---------------------------------------------------------------------------
// Install self-check (SP-4.3)
// ---------------------------------------------------------------------------

test('verification proves every installed hook can decide', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    const res = verifyHostPack(root);
    assert.equal(res.ok, true, `failures: ${res.failures?.join(', ')}`);
    assert.equal(res.hooks.length, 7);
    for (const h of res.hooks) {
        assert.ok(h.decision, `${h.hook} produced no decision`);
    }
});

test('verification fails when the pack cannot run', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    // Corrupt the bundle: every probe must now fail rather than silently reporting "installed".
    const entry = path.join(root, '.harness/host-pack/harness-hook.mjs');
    fs.writeFileSync(entry, 'throw new Error("bundle is broken");\n');
    const res = verifyHostPack(root);
    assert.equal(res.ok, false);
    assert.ok(res.failures.length >= 7 || res.reason, 'a broken pack must be reported');
});

test('provision refuses to declare success when its own guards cannot decide', () => {
    const root = tempConsumer();
    const profiles = [loadHostProfile(PROFILES_DIR, 'cursor-superset')];
    // Make a pack that passes its OWN integrity check but cannot execute — the case the checksum
    // layer cannot catch, and the reason verification exists. Corrupt the source bundle and give
    // the manifest the matching hash so the install copies it happily.
    const srcBundle = path.join(PACK_DIR, 'harness-hook.mjs');
    const srcManifest = path.join(PACK_DIR, 'host-pack.json');
    const savedBundle = fs.readFileSync(srcBundle);
    const savedManifest = fs.readFileSync(srcManifest);
    try {
        const broken = 'throw new Error("bundle is broken");\n';
        fs.writeFileSync(srcBundle, broken);
        const manifest = JSON.parse(savedManifest.toString('utf8'));
        manifest.files['harness-hook.mjs'] = createHash('sha256').update(broken).digest('hex');
        fs.writeFileSync(srcManifest, `${JSON.stringify(manifest, null, 2)}\n`);

        assert.throws(
            () => applyHostProfiles(root, profiles, { observePort: 8792 }),
            /verification failed/,
        );
    } finally {
        fs.writeFileSync(srcBundle, savedBundle);
        fs.writeFileSync(srcManifest, savedManifest);
    }
});

test('a corrupt source pack is refused by the checksum layer before it is installed', () => {
    const root = tempConsumer();
    const profiles = [loadHostProfile(PROFILES_DIR, 'cursor-superset')];
    const srcBundle = path.join(PACK_DIR, 'harness-hook.mjs');
    const saved = fs.readFileSync(srcBundle);
    try {
        fs.writeFileSync(srcBundle, `${saved}\n// tampered\n`);
        assert.throws(() => applyHostProfiles(root, profiles, { observePort: 8792 }), /checksum mismatch/);
    } finally {
        fs.writeFileSync(srcBundle, saved);
    }
});

test('bootstrap records the pack version and verification outcome', () => {
    const root = tempConsumer();
    const profiles = [loadHostProfile(PROFILES_DIR, 'cursor-superset')];
    applyHostProfiles(root, profiles, { observePort: 8792 });
    const boot = JSON.parse(fs.readFileSync(path.join(root, '.harness/host-bootstrap.json'), 'utf8'));
    assert.equal(boot.hostPack.ok, true);
    assert.ok(boot.hostPack.version);
    assert.deepEqual(boot.hostPack.failures, []);
});

// ---------------------------------------------------------------------------
// Pack lifecycle: status / remove-ide / add-ide (SP-2.4)
// ---------------------------------------------------------------------------

test('status reports installed version, integrity and wired trees', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    const status = hostPackStatus(root);
    assert.equal(status.installed, false, 'a bare consumer has no pack');

    installHostPack(root);
    const after = hostPackStatus(root);
    assert.equal(after.installed, true);
    assert.equal(after.ok, true);
    assert.equal(after.outdated, false);
    assert.deepEqual(after.corrupt, []);
});

test('status flags a tampered install instead of calling it healthy', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    fs.appendFileSync(path.join(root, '.harness/host-pack/harness-hook.mjs'), '\n// tampered\n');
    const status = hostPackStatus(root);
    assert.equal(status.ok, false);
    assert.ok(status.corrupt.some((c) => c.includes('harness-hook.mjs')));
});

test('remove-ide unwires our entries and leaves the consumer hooks untouched', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    const profiles = [
        loadHostProfile(PROFILES_DIR, 'cursor-superset'),
        loadHostProfile(PROFILES_DIR, 'agents-superset'),
    ];
    applyHostProfiles(root, profiles, { observePort: 8792, verify: false });

    const hooksPath = path.join(root, '.cursor/hooks.json');
    const doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    doc.hooks.preToolUse = [
        { command: '.cursor/hooks/guard-write.py', matcher: 'Write', failClosed: true },
        ...(doc.hooks.preToolUse || []),
    ];
    fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 4)}\n`);

    const res = removeHostTree(root, 'cursor');
    assert.ok(res.removed.length > 0, 'our entries must be reported as removed');

    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(
        (after.hooks.preToolUse || []).filter((e) => String(e.command).includes('harness-hook.mjs')).length,
        0,
        'no product hook may remain wired',
    );
    assert.ok(
        (after.hooks.preToolUse || []).some((e) => String(e.command) === '.cursor/hooks/guard-write.py'),
        'the consumer guard must survive',
    );
    // An event that held only our entries is dropped rather than left as [].
    assert.equal(after.hooks.beforeSubmitPrompt, undefined);
    // And the other tree is untouched.
    assert.ok(fs.readFileSync(path.join(root, '.agents/hooks.json'), 'utf8').includes('harness-hook.mjs'));
});

test('add-ide applies a profile and records it', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    const res = addHostProfile(root, 'cursor-superset', PROFILES_DIR);
    assert.deepEqual(res.profileIds, ['cursor-superset']);
    assert.equal(res.verification.ok, true);
    const boot = JSON.parse(fs.readFileSync(path.join(root, '.harness/host-bootstrap.json'), 'utf8'));
    assert.deepEqual(boot.profileIds, ['cursor-superset']);
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8'));
    assert.ok(JSON.stringify(hooks).includes('--hook guard-shell'));
});

test('add-ide rejects an unknown profile and names the shipped ones', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    assert.throws(
        () => addHostProfile(root, 'codex-superset', PROFILES_DIR),
        /unknown host profile .*cursor-superset/s,
    );
});

// ---------------------------------------------------------------------------
// Clone survivability: the pack must be committable
// ---------------------------------------------------------------------------

test('provision admits the pack through a consumer .harness/.gitignore', () => {
    // The shipped convention ignores everything in `.harness/` and re-admits a few files. Applied to
    // the host pack, that produces a clone whose hooks.json points at a bundle that is not in the
    // repository — every hook then fails, and because guards fail closed the IDE is unusable.
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.harness/.gitignore'),
        '*\n!.gitignore\n!README.md\n!decision-policy.json\n',
    );
    writeConsumerConfig(root);
    installHostPack(root);

    const rules = fs.readFileSync(path.join(root, '.harness/.gitignore'), 'utf8');
    assert.match(rules, /^!host-pack\/$/m, 'the pack directory must be re-admitted');
    assert.match(rules, /^!host-pack\/\*\*$/m, 'and its contents');
    // `host-install-state.json` matters just as much: without it a merge cannot tell "we wrote this"
    // from "the operator edited it", so the next refresh would duplicate or clobber entries.
    assert.match(rules, /^!host-install-state\.json$/m);
    // Runtime state must stay out of git.
    assert.match(rules, /^\*$/m, 'the blanket ignore must survive');
});

test('gitignore repair is additive and idempotent', () => {
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    const ignorePath = path.join(root, '.harness/.gitignore');
    // An operator rule we must not touch or reorder.
    fs.writeFileSync(ignorePath, '*\n!decision-policy.json\n!my-own-file.json\n');
    writeConsumerConfig(root);

    installHostPack(root);
    const first = fs.readFileSync(ignorePath, 'utf8');
    assert.match(first, /^!my-own-file\.json$/m, "the operator's own rule must survive");

    installHostPack(root);
    installHostPack(root);
    assert.equal(fs.readFileSync(ignorePath, 'utf8'), first, 'repeat runs must not grow the file');
});

test('a consumer with no .harness/.gitignore gets the convention plus our rules', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    installHostPack(root);
    const rules = fs.readFileSync(path.join(root, '.harness/.gitignore'), 'utf8');
    assert.match(rules, /^\*$/m, 'runtime state must be ignored by default');
    assert.match(rules, /^!decision-policy\.json$/m);
    assert.match(rules, /^!host-pack\/\*\*$/m);
});

test('both superset profiles wire the same hook implementations', () => {
    // The two IDE trees must expose the same behaviour. How routing is wired legitimately differs —
    // Cursor uses `stop` plus three `route` entries, Antigravity uses an `agyMerge` block — so the
    // invariant is the set of hook implementations, read from `--hook <name>`, not the entry ids.
    //
    // A `preCompact` entry was dropped from the agents profile exactly this way, and it took a real
    // consumer to notice: x79 kept a stale command pointing at a removed shim.
    const hooksIn = (tree) => {
        const cmds = [];
        const collect = (entries) => {
            for (const e of Array.isArray(entries) ? entries : []) {
                for (const h of Array.isArray(e?.hooks) ? e.hooks : [e]) {
                    if (h?.command) cmds.push(h.command);
                }
            }
        };
        for (const list of Object.values(tree.merge || {})) collect(list);
        for (const events of Object.values(tree.agyMerge || {})) {
            for (const list of Object.values(events)) collect(list);
        }
        return [...new Set(cmds.map(hookNameFromCommand).filter(Boolean))].sort();
    };

    const cursor = loadHostProfile(PROFILES_DIR, 'cursor-superset').cursor;
    const agents = loadHostProfile(PROFILES_DIR, 'agents-superset').agents;
    const claude = loadHostProfile(PROFILES_DIR, 'claude-superset').claude;

    assert.deepEqual(
        hooksIn(cursor),
        hooksIn(agents),
        'Cursor and Antigravity must run the same hooks',
    );
    assert.deepEqual(
        hooksIn(cursor),
        hooksIn(claude),
        'Cursor and Claude Code must run the same hooks',
    );
    assert.ok(hooksIn(agents).includes('pre-compact'), 'preCompact must be wired for Antigravity too');
    assert.ok(hooksIn(claude).includes('pre-compact'), 'preCompact must be wired for Claude too');
});

test('claude-superset provisions .claude/settings.json, guards and CLAUDE.md', () => {
    const root = tempConsumer();
    writeConsumerConfig(root);
    const claudeProfile = loadHostProfile(PROFILES_DIR, 'claude-superset');
    const { actions } = applyHostProfiles(root, [claudeProfile], { observePort: 8792, verify: false });

    assert.ok(actions.length > 0);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), '.claude/settings.json must exist');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks, '.claude/settings.json must contain hooks');
    assert.ok(Array.isArray(settings.hooks.UserPromptSubmit), 'UserPromptSubmit must be array');
    assert.ok(Array.isArray(settings.hooks.PreToolUse), 'PreToolUse must be array');
    assert.ok(Array.isArray(settings.hooks.PostToolUse), 'PostToolUse must be array');
    assert.ok(Array.isArray(settings.hooks.PreCompact), 'PreCompact must be array');

    // Verify CLAUDE.md
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    assert.ok(fs.existsSync(claudeMdPath), 'CLAUDE.md must exist');
    assert.ok(fs.readFileSync(claudeMdPath, 'utf8').includes('# harness-eso: law-gate'));

    // Verify consumer guards copied
    assert.ok(fs.existsSync(path.join(root, '.claude', 'hooks', 'guard-shell.py')));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'hooks', 'guard-write.py')));
});

