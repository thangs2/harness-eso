const MAX_SNIPPET = 1200;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * AgentMemory HTTP recall (III / MCP bridge on localhost).
 * Configure via AGENTMEMORY_HTTP_URL or AGENTMEMORY_URL (default http://127.0.0.1:3111).
 */
export const adapter = {
    id: 'agentmemory-mcp',
    kinds: ['memory'],
    enabled(policy) {
        const mem = policy?.eso?.sources?.memory;
        if (mem?.enabled === false) return false;
        const id = mem?.adapter ?? 'noop-memory';
        return id === 'agentmemory-mcp' || id === 'agentmemory-http';
    },
    async fetch(query, ctx) {
        const q = String(query?.text || query?.query || query || '').trim();
        if (!q) return { snippets: [], trace: 'memory:skip-empty' };
        if (ctx.policy?.eso?.memoryFetch === false || process.env.HARNESS_ESO_MEMORY === '0') {
            return { snippets: [], trace: 'memory:disabled' };
        }

        const base =
            process.env.AGENTMEMORY_HTTP_URL ||
            process.env.AGENTMEMORY_URL ||
            'http://127.0.0.1:3111';
        const max = ctx.maxChars ?? MAX_SNIPPET;
        const text = await fetchMemoryHttp(base, q, max, ctx.fetchImpl);
        if (!text) {
            return { snippets: [], trace: `memory:miss:${q.slice(0, 40)}` };
        }
        return {
            snippets: [{ kind: 'memory', text, query: q, meta: { adapterId: 'agentmemory-mcp' } }],
            trace: `memory:ok:${q.slice(0, 40)}`,
        };
    },
};

async function fetchMemoryHttp(base, query, max, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) return '';
    const url = `${base.replace(/\/$/, '')}/agentmemory/recall`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, limit: 8 }),
            signal: controller.signal,
        });
        if (!res.ok) return '';
        const json = await res.json();
        const hits = json?.memories || json?.results || json?.items || [];
        const blob = hits
            .map((h) => h.content || h.text || h.summary || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        return blob.slice(0, max);
    } catch {
        return '';
    } finally {
        clearTimeout(timer);
    }
}
