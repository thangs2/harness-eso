#!/usr/bin/env node
/**
 * Cross-platform launcher for the hooks a host profile registers.
 *
 * Why this file exists (issue #12, P1/P3)
 * ---------------------------------------
 * Every hook command in `profiles/host/*.json` used to be:
 *
 *     bash -lc 'export HARNESS_TREE=cursor; exec node .harness/host-pack/harness-hook.mjs --hook …'
 *
 * On Windows there is no `bash` on PATH, so the hook exits 127, the host treats the failure as
 * "undecided", and a `failClosed` entry blocks the turn. One line in a profile made the whole product
 * unrunnable on a third of its target platforms, and no test could see it — the suite only ran on
 * macOS.
 *
 * The fix is not "another string that happens to work". A command literal cannot know where the
 * runtime is, so the launcher resolves at run time, in this order:
 *
 *   1. the interpreter running *this* file — the same node that installed the pack already exists;
 *   2. `node` on PATH;
 *   3. a sentence on stderr and exit 2 if neither resolves.
 *
 * It also replaces the shell's `[ -f harness.config.json ] || cd ..` with `..` retries in JS, because
 * a cwd guard written in bash is unavailable in exactly the case it was meant to protect.
 *
 * Dispatch is **in-process**: `harness-hook.mjs`'s `main()` is imported, not spawned. A spawn would
 * add a process per hook on a hot path (two guards run on every tool call) to gain nothing — the work
 * is already in this runtime.
 *
 * Contract: argv and stdin are passed through unchanged, and the exit code is the hook's own, because
 * the host reads the JSON on stdout and the status separately. A launcher that swallowed either would
 * be a second definition of "the hook ran".
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_UP = 3;
const PACK_REL = '.harness/host-pack/harness-hook.mjs';

/**
 * The workspace root, found the way the old shell commands found it: the cwd, or up to `MAX_UP`
 * parents, whichever first contains `harness.config.json`. Hooks that only need the tree (they read
 * `--tree`) do not care; the ones that write state do, and a wrong root writes state in the wrong
 * repo.
 *
 * @param {string} [start]
 * @returns {string} an absolute path (never throws — a consumer without a config is legal)
 */
export function resolveWorkspaceRoot(start = process.cwd()) {
    let dir = path.resolve(start);
    for (let i = 0; i <= MAX_UP; i += 1) {
        if (fs.existsSync(path.join(dir, 'harness.config.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(start);
}

/** Locate the host pack: under the workspace root, then under this launcher's own repo root. */
export function resolvePack(root) {
    const candidates = [
        path.join(root, PACK_REL),
        path.join(root, '.cursor', 'hooks', 'harness-eso', 'harness-hook.mjs'),
        path.join(root, '.agents', 'hooks', 'harness-eso', 'harness-hook.mjs'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || '';
}

/** The node binary to run a hook: this process's own, else whatever is on PATH. */
export function resolveNode() {
    return process.execPath || 'node';
}

function fail(message, code = 2) {
    process.stderr.write(`harness-hook-launcher: ${message}\n`);
    process.exit(code);
}

async function main() {
    const root = resolveWorkspaceRoot();
    // Run from the root so `process.cwd()` inside the hooks means the repo, as it did under bash.
    if (path.resolve(process.cwd()) !== root) {
        try {
            process.chdir(root);
        } catch {
            /* a read-only cwd is not fatal; the hooks mostly read — say nothing and continue */
        }
    }

    const pack = resolvePack(root);
    if (!pack) {
        // Same message shape the dispatcher uses for a missing pack, so an operator who has seen one
        // recognises the other. Exit 2: "cannot run", not "denied".
        const tree = treeFromArgs(process.argv.slice(2));
        process.stdout.write(`${JSON.stringify(denyPayload(tree, `${PACK_REL} is missing — re-run provision to repair the host pack`))}\n`);
        process.exit(2);
    }

    if (!resolveNode()) fail('no node runtime found');

    try {
        await import(pathToFileURL(pack).href);
    } catch (err) {
        process.stderr.write(`harness-hook-launcher: pack failed to load — ${String(err?.message || err)}\n`);
        process.exit(1);
    }
}

/** Read `--tree` without importing the dispatcher (which would run a hook on import). */
function treeFromArgs(argv) {
    const i = argv.indexOf('--tree');
    if (i !== -1 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith('--tree='));
    if (eq) return eq.slice('--tree='.length);
    return process.env.HARNESS_TREE || 'cursor';
}

/** The deny shape the host expects for a tree, kept minimal on purpose. */
function denyPayload(tree, reason) {
    if (tree === 'agents') return { decision: 'deny', reason };
    if (tree === 'claude') return { decision: 'deny', reason, hookSpecificOutput: { permissionDecision: 'deny' } };
    return { permission: 'deny', userMessage: reason, agentMessage: reason };
}

/*
 * Only run when executed as a program. `harness-hook.mjs` imports this module zone for its exported
 * helpers, and importing a launcher must not resolve a root, chdir, or dispatch a hook.
 */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    await main();
}
