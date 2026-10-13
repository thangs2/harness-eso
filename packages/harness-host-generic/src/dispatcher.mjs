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
import { HOOKS, HOOK_NAMES, errorPosture, runHook } from './dispatch.mjs';
import { deny, emitHook } from './hook-io.mjs';
import { loadPolicyForCwd } from './hook-io.mjs';

/** @param {string[]} argv */
export function parseArgs(argv) {
    const flags = { hook: '', tree: '', rest: [] };
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
        } else {
            flags.rest.push(a);
        }
    }
    return flags;
}

/** Response dialect for a tree. Unknown trees fall back to the cursor shape. */
export function shapeFor(tree) {
    return tree === 'agents' ? 'antigravity' : 'cursor';
}

export function usage() {
    return `usage: harness-hook --hook <${HOOK_NAMES.join('|')}> --tree <cursor|agents> [hook args]`;
}

async function main() {
    const { hook, tree, rest } = parseArgs(process.argv.slice(2));
    // Hooks read the tree from the environment (they also handle it being absent).
    if (tree) process.env.HARNESS_TREE = tree;
    const shape = shapeFor(tree);

    if (!hook) {
        // A pack built without `--hook` is a broken install, not a developer error: say so
        // instead of guessing which guard the host meant to run.
        deny(shape, `${usage()}\nRe-run host pack refresh to repair the hook configuration.`);
        return;
    }

    if (!HOOKS[hook]) {
        deny(shape, `harness hook pack: unknown hook "${hook}" (known: ${HOOK_NAMES.join(', ')})`);
        return;
    }

    try {
        await runHook(hook, rest);
    } catch (err) {
        /*
         * A guard that throws has not decided whether the operation is safe, and treating that as
         * `allow` is how an enforcement layer silently stops enforcing. `guards.unavailable` in the
         * consumer policy picks between blocking and warning; the default is block.
         */
        const message = `harness hook pack: ${hook} failed — ${String(err?.message || err)}`;
        const posture = errorPosture(hook, guardPolicy());
        if (posture === 'deny') {
            deny(shape, message, { hookError: true });
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
            );
        } else {
            emitHook({ permission: 'allow', hookError: message }, shape);
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

main().catch((err) => {
    // Last-resort: no shape is known here, so emit the cursor dialect rather than nothing.
    deny('cursor', `harness hook pack crashed: ${String(err?.message || err)}`, { hookCrash: true });
});
