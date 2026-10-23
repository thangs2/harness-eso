/**
 * CLI-side environment defaults and the one-time product-state move.
 *
 * The profiles ship **with** the product, so `HARNESS_PROFILES_DIR` legitimately points into the
 * checkout — the CLI is executing from there anyway. Product *state* does not: it must outlive the
 * checkout, so it lives in `~/.harness` and this module is what brings an existing install across.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProductStateDir, ensureProductState, productStateDir, writeJsonAtomic } from '@mu/harness-foundation/workspace';

const CLI_SRC = path.dirname(fileURLToPath(import.meta.url));

/** The product checkout this CLI runs from. Build-time only — never written into a consumer. */
export const ESO_ROOT = path.resolve(CLI_SRC, '../../..');

/** State files that used to live in the checkout and now belong to the operator's home. */
const MOVED_STATE = ['workspace.json', 'registry.json'];

/**
 * Move product state out of the checkout, once.
 *
 * `~/.harness` is the new home; `<checkout>/.harness` is where it used to be. This copies rather
 * than moves: an operator who downgrades, or wants to diff, still has the original. It runs only
 * when the destination has no `workspace.json`, so it can never overwrite newer state, and it says
 * what it did — a silent migration of the project registry is exactly the kind of thing that makes
 * an operator distrust the tool.
 */
export function migrateLegacyProductState() {
    const dest = productStateDir();
    const legacy = path.join(ESO_ROOT, '.harness');
    if (!fs.existsSync(legacy)) return null;
    if (dest === legacy) return null;
    if (fs.existsSync(path.join(dest, 'workspace.json'))) return null;

    const copied = [];
    fs.mkdirSync(dest, { recursive: true });
    for (const name of MOVED_STATE) {
        const from = path.join(legacy, name);
        if (!fs.existsSync(from)) continue;
        try {
            fs.copyFileSync(from, path.join(dest, name));
            copied.push(name);
        } catch {
            /* a state file we cannot copy is not fatal: the CLI recreates an empty one */
        }
    }

    const legacyProjects = path.join(legacy, 'projects');
    if (fs.existsSync(legacyProjects)) {
        try {
            fs.cpSync(legacyProjects, path.join(dest, 'projects'), { recursive: true });
            copied.push('projects/');
        } catch {
            /* same */
        }
    }

    if (!fs.existsSync(path.join(dest, 'workspace.json'))) {
        writeJsonAtomic(path.join(dest, 'workspace.json'), {
            version: 1,
            defaultProjectId: null,
            projects: [],
        });
    }

    if (copied.length) {
        process.stderr.write(
            `harness: moved product state out of the checkout\n  from ${legacy}\n  to   ${dest}\n  (${copied.join(', ')})\n`,
        );
    }
    return { from: legacy, to: dest, copied };
}

/**
 * Call before any workspace / configure CLI op.
 *
 * Note what is *not* set here any more: `HARNESS_PRODUCT_STATE_DIR`. It used to be forced to
 * `<checkout>/.harness`, which is what tied the operator's project list to the source tree. The
 * default now comes from the foundation (`~/.harness`), and only an explicit override changes it.
 */
export function applyWorkspaceEnv() {
    if (!process.env.HARNESS_PROFILES_DIR) {
        process.env.HARNESS_PROFILES_DIR = path.join(ESO_ROOT, 'profiles');
    }
    migrateLegacyProductState();
    ensureProductState();
}

export { defaultProductStateDir };
