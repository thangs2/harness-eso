const PACKS = {
    tools: {
        bucket: 'tools',
        requiredDocTerms: ['harness-tooling', 'decision-facade', 'harness-eso'],
        minReadPaths: 1,
        lawQueries: ['harness-tooling', 'decision-facade'],
        codeQueries: ['tools/harness'],
    },
    backend: {
        bucket: 'backend',
        requiredDocTerms: ['mu-bible', 'technical-standards'],
        minReadPaths: 1,
        lawQueries: ['mu-bible'],
        codeQueries: ['backend/mu-'],
    },
    frontend: {
        bucket: 'frontend',
        requiredDocTerms: ['stack.fe.angular'],
        minReadPaths: 1,
        lawQueries: ['angular'],
        codeQueries: ['frontend/'],
    },
    docs: {
        bucket: 'docs',
        requiredDocTerms: [],
        minReadPaths: 0,
        lawQueries: [],
        codeQueries: [],
    },
    general: {
        bucket: 'general',
        requiredDocTerms: [],
        minReadPaths: 0,
        lawQueries: [],
        codeQueries: [],
    },
    root: {
        bucket: 'root',
        requiredDocTerms: [],
        minReadPaths: 0,
        lawQueries: [],
        codeQueries: [],
    },
};

/**
 * @param {{ bucket?: string }} surface
 * @param {object} [policy]
 */
export function resolveSkillPack(surface, policy = {}) {
    /*
     * `root` is its **own** pack, not `tools` (G-01).
     *
     * It used to resolve to `tools`, whose `requiredDocTerms` are `harness-tooling`,
     * `decision-facade` and `harness-eso` — documents that exist in this repo and nowhere else. A
     * prompt classified `root` on a consumer therefore inherited three law gaps that no reading of
     * *that* repo could ever close, and the evidence score could not pass `T_high` in any turn. The
     * `root` pack below already declared zero terms; the mapping is what shadowed it.
     *
     * A consumer that genuinely wants the tooling terms in its root turns declares its own
     * `skillPacks.tools` or `skillPacks.root` (the policy branch below), which is a decision it can
     * explain; inheriting them by bucket was not.
     */
    const bucket = surface?.bucket || 'general';
    const packs = policy?.skillPacks || policy?.eso?.skillPacks;
    const policyPack = packs?.[bucket];
    if (policyPack && typeof policyPack === 'object') {
        return {
            bucket,
            requiredDocTerms: Array.isArray(policyPack.requiredDocTerms) ? policyPack.requiredDocTerms : [],
            minReadPaths: typeof policyPack.minReadPaths === 'number' ? policyPack.minReadPaths : 0,
            lawQueries: Array.isArray(policyPack.lawQueries) ? policyPack.lawQueries : [],
            codeQueries: Array.isArray(policyPack.codeQueries) ? policyPack.codeQueries : [],
        };
    }
    const pack = PACKS[bucket] || PACKS.general;
    return { ...pack, bucket };
}
