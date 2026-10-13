export const adapter = {
    id: 'noop-memory',
    kinds: ['memory'],
    enabled(policy) {
        const mem = policy?.eso?.sources?.memory;
        return mem?.enabled === true && mem?.adapter === 'noop-memory';
    },
    async fetch(_query, _ctx) {
        return { snippets: [], trace: 'memory:noop' };
    },
};
