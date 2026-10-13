import { spawnSync } from 'node:child_process';
import { findRepoRoot } from '@mu/harness-foundation/pure';

const MAX_SNIPPET = 1200;

export const adapter = {
    id: 'codegraph-cli',
    kinds: ['code'],
    enabled(policy) {
        return policy?.eso?.sources?.code?.enabled !== false;
    },
    async fetch(query, ctx) {
        const q = String(query?.text || query?.query || query || '').trim();
        if (!q) return { snippets: [], trace: 'codegraph:skip-empty' };
        const root = ctx.root || findRepoRoot();
        const max = ctx.maxChars ?? MAX_SNIPPET;
        const bin = process.env.CODEGRAPH_BIN || 'codegraph';
        const args = ['explore', '--question', q];
        const cwd = root || process.cwd();
    let r;
    try {
        r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
        return { snippets: [], trace: `codegraph:error:${String(err?.message || err).slice(0, 40)}` };
    }
    if (r.error?.code === 'ETIMEDOUT') {
        return { snippets: [], trace: `codegraph:timeout:${q.slice(0, 40)}` };
    }
    if (r.status !== 0 || !r.stdout?.trim()) {
        const hint = r.stderr?.trim().slice(0, 80) || `exit ${r.status}`;
        return { snippets: [], trace: `codegraph:miss:${q.slice(0, 40)}:${hint}` };
    }
        const text = r.stdout.trim().slice(0, max);
        return {
            snippets: [{ kind: 'code', text, query: q, meta: { adapterId: 'codegraph-cli' } }],
            trace: `codegraph:ok:${q.slice(0, 40)}`,
        };
    },
};
