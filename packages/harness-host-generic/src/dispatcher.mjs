#!/usr/bin/env node
/**
 * Host pack entry point — the single file every IDE hook invokes.
 *
 * The pack used to ship one script per hook, plus a shim that spawned the real implementation
 * out of the harness-eso checkout. That made the checkout a runtime dependency: `git clean` in
 * harness-eso broke the consumer's guards, and `.harness/sidecar.env` had to carry an absolute
 * path back to the product repo. Now every hook implementation is bundled into this file and the
 * IDE config only names the hook:
 *
 *   node .harness/host-pack/harness-hook.mjs --hook guard-shell --tree cursor
 *   node .harness/host-pack/harness-hook.mjs --hook route --tree agents --event PreToolUse
 *
 * `--tree` selects the session directory and the response shape; the hook code itself is
 * IDE-agnostic, so adding an IDE is a config change rather than a new copy of the pack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOKS, HOOK_NAMES, errorPosture, runHook } from './dispatch.mjs';
import { deny, emitHook } from './hook-io.mjs';
import { loadPolicyForCwd } from './hook-io.mjs';

// Self-heal working directory: if runner (such as Antigravity or Claude Code) spawns the hook with
// cwd set to .agents/, .cursor/, or .claude/, normalize process.cwd() back to the workspace root.
const cwdBase = path.basename(process.cwd());
if (cwdBase === '.agents' || cwdBase === '.cursor' || cwdBase === '.claude') {
    try {
        process.chdir(path.resolve(process.cwd(), '..'));
    } catch {
        // Fallback silently if chdir fails
    }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
    const flags = { hook: '', tree: '', event: '', rest: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--hook' && argv[i + 1]) {
            flags.hook = argv[i + 1];
            i += 1;
        } else if (a.startsWith('--hook=')) {
            flags.hook = a.slice('--hook='.length);
        } else if (a === '--tree' && argv[i + 1]) {
            flags.tree = argv[i + 1];
            i += 1;
        } else if (a.startsWith('--tree=')) {
            flags.tree = a.slice('--tree='.length);
        } else if (a === '--event' && argv[i + 1]) {
            flags.event = argv[i + 1];
            i += 1;
        } else if (a.startsWith('--event=')) {
            flags.event = a.slice('--event='.length);
        } else {
            flags.rest.push(a);
        }
    }
    return flags;
}

/** Response dialect for a tree. Unknown trees fall back to the cursor shape. */
export function shapeFor(tree) {
    if (tree === 'agents') return 'antigravity';
    if (tree === 'claude') return 'claude';
    return 'cursor';
}

export function usage() {
    return `usage: harness-hook --hook <${HOOK_NAMES.join('|')}> --tree <cursor|agents|claude> [--event <event>] [hook args]`;
}

async function main() {
    const { hook, tree, event, rest } = parseArgs(process.argv.slice(2));
    // Hooks read the tree and hook name from the environment (they also handle it being absent).
    if (hook) process.env.HARNESS_HOOK = hook;
    if (tree) process.env.HARNESS_TREE = tree;
    if (event) {
        process.env.HARNESS_EVENT = event;
        process.env.ROUTE_AGY_EVENT = event;
    }
    const shape = shapeFor(tree);

    if (!hook) {
        // A pack built without `--hook` is a broken install, not a developer error: say so
        // instead of guessing which guard the host meant to run.
        deny(shape, `${usage()}\nRe-run host pack refresh to repair the hook configuration.`, {}, event);
        return;
    }

    if (!HOOKS[hook]) {
        deny(shape, `harness hook pack: unknown hook "${hook}" (known: ${HOOK_NAMES.join(', ')})`, {}, event);
        return;
    }

    try {
        const hookArgs = event && !rest.includes('--event') ? ['--event', event, ...rest] : rest;
        await runHook(hook, hookArgs);
    } catch (err) {
        /*
         * A guard that throws has not decided whether the operation is safe, and treating that as
         * `allow` is how an enforcement layer silently stops enforcing. `guards.unavailable` in the
         * consumer policy picks between blocking and warning; the default is block.
         */
        const message = `harness hook pack: ${hook} failed — ${String(err?.message || err)}`;
        const posture = errorPosture(hook, guardPolicy());
        if (posture === 'deny') {
            deny(shape, message, { hookError: true }, event);
        } else if (posture === 'warn') {
            // Loud but non-blocking: the operator asked for availability over enforcement, so the
            // call proceeds and the turn carries a visible note that no guard ran.
            emitHook(
                {
                    permission: 'allow',
                    hookError: message,
                    additional_context: `[HARNESS GUARD UNAVAILABLE] ${message}`,
                },
                shape,
                event,
            );
        } else {
            emitHook({ permission: 'allow', hookError: message }, shape, event);
        }
    }
}

/** `guards.unavailable` from the consumer policy, when it can be read. */
function guardPolicy() {
    try {
        const { policy } = loadPolicyForCwd();
        return policy?.guards;
    } catch {
        // Policy unreadable is itself a failure: fall back to the hook's own default rather than
        // to `warn`, so an unreadable policy cannot loosen a guard.
        return undefined;
    }
}

/**
 * The dispatcher's normal entry point. Exported so the cross-platform launcher can run a hook
 * in-process instead of spawning another `node` for every tool call (issue #12, P1).
 *
 * @returns {Promise<void>} resolves after a response has been written to stdout
 */
export async function run() {
    try {
        await main();
    } catch (err) {
        // Not rethrown: an unhandled rejection would print a stack and exit non-zero *after* the deny
        // has already been written, which reads to the host as a crash on top of a decision.
        deny('cursor', `harness hook pack crashed: ${String(err?.message || err)}`, { hookCrash: true });
    }
}

/*
 * Only run when executed as a program: `node …/harness-hook.mjs --hook X`.
 *
 * Both sides go through `realpathSync` because comparing the unresolved forms is wrong on macOS:
 * `os.tmpdir()` is `/var/folders/…`, which is a symlink to `/private/var/folders/…`, so the hook
 * loaded normally and produced **no output at all** — no deny, no allow, just silence that a host
 * reads as a crash. Failing to resolve must not silently disable the pack, so an unresolvable argv
 * falls back to running (a stray dispatch is louder than none).
 */
function isDirectInvocation() {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
        return pathToFileURL(fs.realpathSync(argv1)).href === pathToFileURL(fs.realpathSync(new URL(import.meta.url))).href;
    } catch {
        return true;
    }
}

if (isDirectInvocation()) {
    // `run()` already catches; the `.catch` here only covers a failure to *reach* `main()`.
    run().catch((err) => {
        // Last-resort: no shape is known here, so emit the cursor dialect rather than nothing.
        deny('cursor', `harness hook pack crashed: ${String(err?.message || err)}`, { hookCrash: true });
    });
}
