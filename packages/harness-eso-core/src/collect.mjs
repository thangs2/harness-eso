import { createSourceRegistry } from './adapter-registry.mjs';
import { resolveSkillPack } from './skill-pack.mjs';

/**
 * @param {object} pack
 * @param {object} retrieval
 * @param {string} stem
 */
export function detectGaps(pack, retrieval, stem) {
    const gaps = [];
    const lawText = (retrieval.snippets || [])
        .filter((s) => s.kind === 'law')
        .map((s) => s.text)
        .join('\n')
        .toLowerCase();

    for (const term of pack.requiredDocTerms || []) {
        const t = term.toLowerCase();
        if (!lawText.includes(t)) {
            gaps.push({ kind: 'law', query: term, priority: 1 });
        }
    }

    const readCount = retrieval.reads?.readCount ?? 0;
    const minReads = pack.minReadPaths ?? 0;
    if (readCount < minReads && minReads > 0) {
        gaps.push({
            kind: 'code',
            query: `need at least ${minReads} file read(s); have ${readCount}`,
            priority: 2,
        });
    }

    if (!String(stem || '').trim()) {
        gaps.push({ kind: 'human', query: 'missing user query stem', priority: 3 });
    }

    return gaps;
}

/**
 * @param {object} pack
 * @param {object} retrieval
 * @param {object[]} gaps
 * @param {string} stem
 * @param {{ T_low: number, T_high: number }} thresholds
 */
export function scoreSufficiency(pack, retrieval, gaps, stem, thresholds) {
    const required = pack.requiredDocTerms?.length || 0;
    const lawSnippets = (retrieval.snippets || []).filter((s) => s.kind === 'law');
    let lawHit = 0;
    const lawBlob = lawSnippets.map((s) => s.text).join('\n').toLowerCase();
    for (const term of pack.requiredDocTerms || []) {
        if (lawBlob.includes(term.toLowerCase())) lawHit += 1;
    }
    const lawRatio = required ? lawHit / required : 1;

    const reads = retrieval.reads?.readCount ?? 0;
    /*
     * `minReadPaths: 0` means the pack requires **no** file read, so reading nothing must not cost
     * score. `Math.max(pack.minReadPaths ?? 0, 1)` forced the minimum to 1, which made two things
     * true at once: the `minReads === 0` branch below was unreachable, and the `docs` / `general` /
     * `root` packs — which all declare 0 — were scored as though they demanded a read. A docs turn
     * that read nothing lost 45% of its score for a requirement its own pack says does not exist.
     *
     * It also disagreed with `detectGaps`, which reads the same field as `?? 0`. Gaps and score have
     * to agree about what the pack requires, or the score is not explainable from the reported gaps.
     */
    const minReads = pack.minReadPaths ?? 0;
    const readRatio = minReads === 0 ? 1 : Math.min(1, reads / minReads);

    let score = lawRatio * 0.55 + readRatio * 0.45;
    score = Math.max(0, Math.min(1, score));

    let level = 'insufficient';
    if (score >= thresholds.T_high && gaps.length === 0) level = 'sufficient';
    else if (score >= thresholds.T_low) level = 'partial';

    if (gaps.some((g) => g.kind === 'human' && g.query?.includes('missing user'))) {
        level = level === 'sufficient' ? 'partial' : level;
    }

    return { score, level, lawRatio, readRatio };
}

/**
 * COLLECT — adapter registry + gap measure.
 * @param {object} input
 * @param {{ policy: object, eso: object, surface: object, stem: string, root?: string, reads?: object, registry?: object, injectSnippets?: object[] }} ctx
 */
export async function runCollect(input, ctx) {
    const pack = resolveSkillPack(ctx.surface);
    const registry = ctx.registry || createSourceRegistry(ctx.policy);
    const snippets = [...(ctx.injectSnippets || [])];
    const trace = [];

    const lawAdapter = registry.resolve('law');
    if (lawAdapter) {
        for (const q of pack.lawQueries || []) {
            const r = await lawAdapter.fetch(q, { root: ctx.root, policy: ctx.policy });
            trace.push(r.trace);
            snippets.push(...(r.snippets || []));
        }
    }
    const codeAdapter = registry.resolve('code');
    if (codeAdapter) {
        for (const q of pack.codeQueries || []) {
            const r = await codeAdapter.fetch(q, { root: ctx.root, policy: ctx.policy });
            trace.push(r.trace);
            snippets.push(...(r.snippets || []));
        }
    }
    const memoryAdapter = registry.resolve('memory');
    if (memoryAdapter && ctx.eso?.memoryFetch !== false) {
        const memQ = stem || pack.lawQueries?.[0] || 'harness context';
        const r = await memoryAdapter.fetch(memQ, { root: ctx.root, policy: ctx.policy });
        trace.push(r.trace);
        snippets.push(...(r.snippets || []));
    }

    const retrieval = {
        snippets,
        trace,
        reads: ctx.reads || { readCount: 0, paths: [] },
    };
    const stem = ctx.stem ?? input?.userQueryStem ?? '';
    const gaps = detectGaps(pack, retrieval, stem);
    const measure = scoreSufficiency(pack, retrieval, gaps, stem, ctx.eso.thresholds);

    return { pack, retrieval, gaps, measure };
}
