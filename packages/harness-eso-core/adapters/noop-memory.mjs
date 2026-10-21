export const adapter = {
    id: 'noop-memory',
    kinds: ['memory'],
    /*
     * Selection belongs to the registry, not to the adapter: with a provider chain
     * (`prefer: [native], fallback: [agentmemory-mcp]`) an adapter cannot know whether it was
     * chosen. `enabled` therefore answers only "may this source be used at all".
     */
    enabled(policy) {
        return policy?.eso?.sources?.memory?.enabled !== false;
    },
    async fetch(_query, _ctx) {
        return { snippets: [], trace: 'memory:noop' };
    },
};
