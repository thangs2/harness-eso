export const adapter = {
    id: 'noop-memory',
    kinds: ['memory'],
    /*
     * Selection belongs to the registry, not to the adapter: with a provider chain
     * (`prefer: [native], fallback: [agentmemory-mcp]`) an adapter cannot know whether it was
     * chosen. `enabled` therefore answers only "may this source be used at all".
     */
    /*
     * `requireExplicit`: memory must never be switched on implicitly. The legacy default path (no
     * chain in policy) used to return null because every memory adapter self-gated on `adapter`;
     * now that selection moved to the registry, this flag preserves that "opt-in" property while
     * still allowing a chain to name the provider.
     */
    requireExplicit: true,
    enabled(policy) {
        return policy?.eso?.sources?.memory?.enabled !== false;
    },
    async fetch(_query, _ctx) {
        return { snippets: [], trace: 'memory:noop' };
    },
};
