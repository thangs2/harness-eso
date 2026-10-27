import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';

export const RUNTIME_DIR = '.harness';

export const RUNTIME_FILES = {
    decisionPolicy: 'decision-policy.json',
    harnessDb: 'harness.db',
};

/** @param {string} [repoRoot] */
export function harnessDir(repoRoot = findRepoRoot()) {
    return repoRoot ? path.join(repoRoot, RUNTIME_DIR) : '';
}

/** @param {string} [repoRoot] */
export function decisionPolicyFile(repoRoot = findRepoRoot()) {
    const dir = harnessDir(repoRoot);
    return dir ? path.join(dir, RUNTIME_FILES.decisionPolicy) : '';
}

/** @param {string} [repoRoot] */
export function harnessDbFile(repoRoot = findRepoRoot()) {
    const dir = harnessDir(repoRoot);
    return dir ? path.join(dir, RUNTIME_FILES.harnessDb) : '';
}

/** Override for a host that keeps its sessions outside the repo (DSH: `~/.dsh/sessions`). */
export const SESSION_DIR_ENV = 'HARNESS_SESSION_DIR';

/**
 * The session directory for one tree.
 *
 * Derived from the tree by default, so Cursor and Antigravity are unchanged. `HARNESS_SESSION_DIR`
 * overrides it with an ABSOLUTE path for a host whose sessions live outside the repo — DSH writes
 * `~/.dsh/sessions`, and the guard would otherwise look for a stamp the agent cannot reach, or accept
 * one it never reads.
 *
 * Every reader must go through this function: `guard-write.py` derives the same value from its own file
 * path and honours the same variable. A second, independent answer here is how the pack would end up
 * writing a stamp into one directory while the guard reads another — the exact defect the override
 * exists to remove.
 *
 * An in-repo override is refused rather than honoured: a session dir inside the repo is writable by the
 * agent, so its exemption from the gate would be forgeable.
 *
 * @param {'cursor'|'agents'|'claude'} tree
 * @param {string} [repoRoot]
 */
export function sessionDir(repoRoot, tree = 'cursor') {
    const root = repoRoot || findRepoRoot();
    const override = String(process.env[SESSION_DIR_ENV] || '').trim();
    if (override) {
        if (!path.isAbsolute(override)) {
            throw new Error(`${SESSION_DIR_ENV} must be absolute, got: ${override}`);
        }
        const clean = path.resolve(override);
        const cleanRoot = root ? path.resolve(root) : '';
        if (cleanRoot && (clean === cleanRoot || clean.startsWith(`${cleanRoot}${path.sep}`))) {
            throw new Error(
                `${SESSION_DIR_ENV} must lie outside the repo: an in-repo session dir is reachable as a gated ` +
                    `path and its exemption would be forgeable (got ${clean}, root ${cleanRoot})`,
            );
        }
        return clean;
    }
    if (!root) return '';
    const t = tree === 'agents' ? 'agents' : tree === 'claude' ? 'claude' : 'cursor';
    return path.join(root, `.${t}`, 'session');
}
