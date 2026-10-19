import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalizes a user query stem:
 * - strips markdown/xml tags and punctuation noise
 * - collapses whitespace
 * - lowercases and trims
 * - enforces maximum length of 240 chars
 *
 * @param {string} stem
 * @returns {string}
 */
export function normalizeStem(stem) {
    if (!stem || typeof stem !== 'string') return '';
    return stem
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_~#]/g, '')
        .replace(/[\[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, 240);
}

/**
 * Reads current git HEAD reference or commit hash directly from filesystem without spawning git.
 *
 * @param {string} root
 * @returns {string}
 */
export function readGitHead(root) {
    if (!root) return '';
    try {
        const headPath = path.join(root, '.git', 'HEAD');
        if (!fs.existsSync(headPath)) return '';
        const headContent = fs.readFileSync(headPath, 'utf8').trim();
        if (headContent.startsWith('ref: ')) {
            const refRel = headContent.slice(5).trim();
            const refPath = path.join(root, '.git', refRel);
            if (fs.existsSync(refPath)) {
                return fs.readFileSync(refPath, 'utf8').trim().slice(0, 40);
            }
            return refRel;
        }
        return headContent.slice(0, 40);
    } catch {
        return '';
    }
}

/**
 * Reads git index modification time (mtimeMs).
 * Fast heuristic (< 1ms) to detect working tree / stage modifications without shelling git status.
 *
 * @param {string} root
 * @returns {number}
 */
export function readIndexMtime(root) {
    if (!root) return 0;
    try {
        const indexPath = path.join(root, '.git', 'index');
        if (!fs.existsSync(indexPath)) return 0;
        return fs.statSync(indexPath).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * Computes a fast, deterministic 16-hex task fingerprint:
 * F = SHA256(stemHash : gitHead : indexMtime : contractHash)
 *
 * Used to lock continuation short-circuits and detect intent drift or working-tree changes.
 *
 * @param {{ stem?: string, root?: string, contractHash?: string }} [opts]
 * @returns {string}
 */
export function computeFastFingerprint({ stem = '', root = '', contractHash = '' } = {}) {
    const norm = normalizeStem(stem);
    const stemHash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
    const gitHead = readGitHead(root);
    const indexMtime = readIndexMtime(root);
    const raw = `${stemHash}:${gitHead}:${indexMtime}:${contractHash || ''}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
