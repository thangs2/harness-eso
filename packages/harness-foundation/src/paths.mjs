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

/**
 * @param {'cursor'|'agents'} tree
 * @param {string} [repoRoot]
 */
export function sessionDir(repoRoot, tree = 'cursor') {
    const root = repoRoot || findRepoRoot();
    if (!root) return '';
    const t = tree === 'agents' ? 'agents' : 'cursor';
    return path.join(root, `.${t}`, 'session');
}
