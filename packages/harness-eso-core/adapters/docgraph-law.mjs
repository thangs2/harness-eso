import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRepoRoot } from '@mu/harness-foundation/pure';

const MAX_SNIPPET = 1200;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const adapter = {
    id: 'docgraph-cli',
    kinds: ['law'],
    enabled(policy) {
        return policy?.eso?.sources?.law?.enabled !== false;
    },
    async fetch(query, ctx) {
        const q = String(query?.text || query?.query || query || '').trim();
        if (!q) return { snippets: [], trace: 'docgraph:skip-empty' };
        const root = ctx.root || findRepoRoot();
        const max = ctx.maxChars ?? MAX_SNIPPET;
        const snippet = fetchDocgraph(q, root, max);
        if (!snippet) return { snippets: [], trace: `docgraph:miss:${q.slice(0, 40)}` };
        return {
            snippets: [{ kind: 'law', text: snippet, query: q, meta: { adapterId: 'docgraph-cli' } }],
            trace: `docgraph:ok:${q.slice(0, 40)}`,
        };
    },
};

function cacheFile(root, query) {
    const hash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 32);
    return path.join(root, '.harness', 'cache', 'docgraph', `${hash}.txt`);
}

function readCache(filePath) {
    try {
        const st = fs.statSync(filePath);
        if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return null;
    }
}

function writeCache(filePath, text) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, text, 'utf8');
    } catch {
        /* best-effort */
    }
}

function fetchDocgraph(query, root, max) {
    if (root) {
        const cached = readCache(cacheFile(root, query));
        if (cached) return cached.slice(0, max);
    }
    const bin = process.env.DOCGRAPH_BIN || 'docgraph';
    const args = ['--q', query];
    const cwd = root || process.cwd();
    let r;
    try {
        r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    } catch {
        return '';
    }
    if (r.error?.code === 'ETIMEDOUT') return '';
    if (r.status !== 0 || !r.stdout?.trim()) return '';
    const text = r.stdout.trim().slice(0, max);
    if (root && text) writeCache(cacheFile(root, query), text);
    return text;
}
