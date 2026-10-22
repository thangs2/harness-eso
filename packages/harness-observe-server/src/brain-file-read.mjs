import fs from 'node:fs';
import path from 'node:path';

/**
 * Read one file for the Brain card's "open" action.
 *
 * This is the only route in the Observatory that reads an arbitrary path, so it is guarded by two
 * independent gates, not one:
 *
 *   1. **Allowlist** — the path must be a `note` node the caller can already see in
 *      `/api/brain/graph.json`. The DB decided which paths exist; the request cannot invent one.
 *   2. **Containment** — the *real* path (symlinks resolved) must stay inside the project root.
 *      Checked with a separator, so `/root-evil` does not pass as `/root`.
 *
 * Plus a text-extension allowlist, a byte cap (read truncated, never load a 2 GB log) and a binary
 * sniff (never stream NUL bytes into an HTML page). The route is GET-only: nothing here writes.
 */
export const BRAIN_FILE_MAX_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 4096;

/** Extensions a text preview may render. Everything else is refused instead of guessed. */
export const BRAIN_TEXT_EXTENSIONS = new Set([
    '.md', '.mdx', '.mdc', '.txt', '.log', '.csv',
    '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.jsonl',
    '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.properties',
    '.css', '.scss', '.html', '.htm', '.xml', '.svg', '.sql', '.sh', '.bash', '.zsh',
    '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.graphql', '.proto', '.diff', '.patch',
]);

const ALLOWED_BASENAMES = new Set([
    'dockerfile',
    'makefile',
    '.gitignore',
    '.gitattributes',
    '.npmrc',
    '.editorconfig',
    '.dockerignore',
]);

function fail(code, message, status) {
    return { ok: false, code, message, status };
}

/** Separator-aware containment: `/a/root-evil` must not count as inside `/a/root`. */
export function isWithinRoot(root, candidate) {
    if (!root || !candidate) return false;
    const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return candidate === root || candidate.startsWith(base);
}

function looksBinary(buffer) {
    const limit = Math.min(buffer.length, 8192);
    for (let i = 0; i < limit; i += 1) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

function realpathOrNull(target) {
    try {
        return fs.realpathSync(target);
    } catch {
        return null;
    }
}

function normalizeAllowlist(allowedPaths) {
    const set = new Set();
    for (const entry of allowedPaths ?? []) {
        if (typeof entry !== 'string' || entry.length === 0) continue;
        const resolved = path.resolve(entry);
        set.add(resolved);
        // Recorded path and real path can differ (symlinked temp dirs, macOS /var -> /private/var).
        const real = realpathOrNull(resolved);
        if (real) set.add(real);
    }
    return set;
}

/**
 * @param {{
 *   requestedPath: unknown,
 *   root: string,
 *   allowedPaths: Iterable<string>,
 *   maxBytes?: number,
 * }} input
 * @returns {{ ok: true, path: string, relativePath: string, bytes: number, shownBytes: number,
 *             truncated: boolean, text: string }
 *          | { ok: false, code: string, message: string, status: number }}
 */
export function resolveBrainFile({ requestedPath, root, allowedPaths, maxBytes = BRAIN_FILE_MAX_BYTES }) {
    const raw = typeof requestedPath === 'string' ? requestedPath : '';
    if (!raw || raw.length > MAX_PATH_LENGTH || raw.includes('\u0000')) {
        return fail('invalid_path', 'path is empty, too long, or contains a NUL byte', 400);
    }

    const rootReal = realpathOrNull(path.resolve(root)) ?? path.resolve(root);
    const requested = path.resolve(raw);
    const allowed = normalizeAllowlist(allowedPaths);
    if (!allowed.has(requested)) {
        return fail('not_allowed', 'path is not a node of this brain graph', 403);
    }

    // Containment is decided on the *real* path, because that is the file we would read. Checking
    // the requested spelling alone lets a symlink walk out of the root.
    const real = realpathOrNull(requested);
    if (!real) return fail('missing', 'file not found', 404);
    if (!isWithinRoot(rootReal, real)) {
        return fail('outside_root', 'path resolves outside the project root', 403);
    }

    let stat;
    try {
        stat = fs.statSync(real);
    } catch {
        return fail('missing', 'file not found', 404);
    }
    if (!stat.isFile()) return fail('not_a_file', 'path is not a regular file', 400);

    const extension = path.extname(real).toLowerCase();
    const baseName = path.basename(real).toLowerCase();
    if (!BRAIN_TEXT_EXTENSIONS.has(extension) && !ALLOWED_BASENAMES.has(baseName)) {
        return fail('unsupported_type', `${extension || '(no extension)'} is not previewable as text`, 415);
    }

    const shownBytes = Math.min(stat.size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(shownBytes);
    let handle;
    try {
        handle = fs.openSync(real, 'r');
        if (shownBytes > 0) fs.readSync(handle, buffer, 0, shownBytes, 0);
    } catch {
        return fail('missing', 'file could not be read', 404);
    } finally {
        if (handle != null) fs.closeSync(handle);
    }
    if (looksBinary(buffer)) {
        return fail('binary', 'file contains NUL bytes — refusing to render it as text', 415);
    }

    return {
        ok: true,
        path: real,
        relativePath: path.relative(rootReal, real).split(path.sep).join('/'),
        bytes: stat.size,
        shownBytes,
        truncated: stat.size > shownBytes,
        text: buffer.toString('utf8'),
    };
}
