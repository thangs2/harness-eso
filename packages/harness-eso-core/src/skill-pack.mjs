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
 */
export function resolveSkillPack(surface) {
    const bucket = surface?.bucket === 'root' ? 'tools' : surface?.bucket || 'general';
    const pack = PACKS[bucket] || PACKS.general;
    return { ...pack, bucket };
}
