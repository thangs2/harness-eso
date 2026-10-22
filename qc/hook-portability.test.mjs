import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Host profiles must not require a shell the target OS does not have (issue #12, P1).
 *
 * What broke: every hook command was
 *
 *     bash -lc 'export HARNESS_TREE=cursor; exec node .harness/host-pack/harness-hook.mjs --hook …'
 *
 * Windows has no `bash` on PATH. The hook exits 127, the host treats the failure as "undecided", and
 * a `failClosed` entry blocks the turn — so one string in a profile made the product unrunnable on one
 * of its three target platforms, and every test stayed green because the suite only ran on macOS.
 *
 * The rule this file pins:
 *
 *   1. no `command` in `profiles/host/*.json` may invoke `bash`, `sh`, or a bare `python`;
 *   2. the tree must travel in `--tree`, not in `export …` (an env var needs a shell to set it);
 *   3. the only allowed non-node interpreter is a consumer-owned `.py` file, and only because the pack
 *      has no replacement for it — that exception is asserted by name, not by pattern, so adding a
 *      second one is a deliberate edit;
 *   4. every command names the pack entrypoint, so the pack is the thing that runs.
 */

const HOST_PROFILES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles', 'host');

function profileCommands() {
    const out = [];
    for (const name of fs.readdirSync(HOST_PROFILES).filter((f) => f.endsWith('.json'))) {
        const doc = JSON.parse(fs.readFileSync(path.join(HOST_PROFILES, name), 'utf8'));
        // Walk arbitrary depth: the three hosts nest hooks differently and the walker must not care.
        const walk = (node) => {
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== 'object') return;
            if (typeof node.command === 'string') out.push({ profile: name, command: node.command });
            Object.values(node).forEach(walk);
        };
        walk(doc);
    }
    return out;
}

test('the profile walker finds every hook command (a walker that found nothing would pass silently)', () => {
    const commands = profileCommands();
    assert.ok(commands.length >= 29, `expected at least 29 hook commands across the three profiles, found ${commands.length}`);
});

test('no hook command invokes a shell', () => {
    const offenders = profileCommands().filter((c) => /(^|[\s'"])(bash|sh|zsh)(\s|$)/.test(c.command));
    assert.deepEqual(
        offenders.map((c) => `${c.profile}: ${c.command}`),
        [],
        'a shell in a hook command exits 127 on Windows and blocks the turn when failClosed',
    );
});

test('no hook command exports an environment variable', () => {
    const offenders = profileCommands().filter((c) => /\bexport\s+[A-Z_]+=/.test(c.command));
    assert.deepEqual(
        offenders.map((c) => `${c.profile}: ${c.command}`),
        [],
        'an env var needs a shell to set it; pass --tree instead, which every hook already reads',
    );
});

test('the only python command is the consumer-owned write guard', () => {
    const pythons = profileCommands().filter((c) => /\bpython(3)?\b/.test(c.command));
    assert.deepEqual(
        pythons.map((c) => `${c.profile}: ${c.command}`),
        ['claude-superset.json: python3 .claude/hooks/guard-write.py'],
        'the pack has no write gate (F26); a new python hook needs its own justification here',
    );
});

test('every non-python hook command runs the pack entrypoint with --hook and --tree', () => {
    const problems = [];
    for (const { profile, command } of profileCommands()) {
        if (/\bpython(3)?\b/.test(command)) continue;
        if (!command.includes('.harness/host-pack/harness-hook.mjs')) problems.push(`${profile}: missing pack entrypoint — ${command}`);
        if (!/--hook[= ]\S+/.test(command)) problems.push(`${profile}: missing --hook — ${command}`);
        if (!/--tree[= ](cursor|agents|claude)\b/.test(command)) problems.push(`${profile}: missing --tree — ${command}`);
    }
    assert.deepEqual(problems, []);
});

test('every hook command works with no bash on PATH', () => {
    /*
     * Behavioural half. The commands are literals the host runs; the portable claim is that they
     * resolve without a shell, so run the pack entrypoint directly for each distinct `--hook` value
     * with a deliberately bash-less PATH and require a JSON decision on stdout.
     *
     * Skipped when the pack is not built: `dist/` is a build artifact, and a test that fails because a
     * developer has not run `bun run build:host-pack` teaches the wrong lesson.
     */
    const pack = path.resolve(HOST_PROFILES, '..', '..', 'packages', 'harness-host-generic', 'dist', 'host-pack', 'harness-hook.mjs');
    if (!fs.existsSync(pack)) return;

    const hooks = new Set();
    for (const { command } of profileCommands()) {
        const m = /--hook[= ]([A-Za-z0-9_-]+)/.exec(command);
        if (m && !/\bpython(3)?\b/.test(command)) hooks.add(m[1]);
    }
    assert.ok(hooks.size >= 5, `expected several distinct hooks, found ${[...hooks].join(', ')}`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hookpath-'));
    try {
        for (const hook of hooks) {
            const res = spawnSyncNoShell(process.execPath, [pack, '--hook', hook, '--tree', 'cursor'], dir);
            assert.ok(
                /"permission"|"decision"|"hookSpecificOutput"/.test(res.stdout),
                `${hook} produced no decision without a shell: stdout=${res.stdout.slice(0, 200)} stderr=${res.stderr.slice(0, 200)}`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Run node with a PATH that cannot contain bash (an empty directory), as a Windows host would. */
function spawnSyncNoShell(bin, args, cwd) {
    const emptyBin = path.join(cwd, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const res = spawnSync(bin, args, {
        cwd,
        encoding: 'utf8',
        input: '{"command":"ls","tool_input":{}}',
        timeout: 30_000,
        env: { ...process.env, PATH: emptyBin, HARNESS_TREE: 'cursor', HARNESS_PRODUCT_STATE_DIR: cwd },
    });
    return { stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), status: res.status };
}
