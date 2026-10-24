import { loadSkillPacks, parseSkillPacks } from '@mu/harness-foundation/pure';

import { createSourceRegistry } from './adapter-registry.mjs';
import { resolveSkillPack } from './skill-pack.mjs';

/**
 * Fold the separators the packs use in document names, so a term matches the document it names.
 *
 * A `requiredDocTerms` entry is a **document name** — `harness-tooling`, `stack.fe.angular` — and the
 * ids docgraph returns for those documents are written the same way, so the comparison is a
 * slug-versus-slug one. Folding is also what stops `stack.fe` from matching `stack.fe.angular`.
 */
function foldSlug(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Document ids / paths a snippet came from, as folded slugs. */
function snippetSlugs(snippet) {
    const ids = [
        snippet?.id,
        snippet?.docId,
        snippet?.path,
        snippet?.source,
        ...(Array.isArray(snippet?.meta?.docIds) ? snippet.meta.docIds : []),
        ...(Array.isArray(snippet?.meta?.paths) ? snippet.meta.paths : []),
    ];
    const out = new Set();
    for (const raw of ids) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        for (const part of [raw, String(raw).split(/[\\/]/).pop()]) {
            const slug = foldSlug(part).replace(/\.[a-z0-9]+$/, '');
            if (slug) out.add(slug);
        }
    }
    return out;
}

/**
 * @param {object} pack
 * @param {object} retrieval
 * @param {string} stem
 */
export function detectGaps(pack, retrieval, stem) {
    const gaps = [];
    const lawSnippets = (retrieval.snippets || []).filter((s) => s.kind === 'law');
    const lawText = lawSnippets
        .map((s) => s.text)
        .join('\n')
        .toLowerCase();
    const resolvedDocs = new Set();
    for (const snippet of lawSnippets) {
        for (const slug of snippetSlugs(snippet)) resolvedDocs.add(slug);
    }
    const bodyHas = new Set();
    for (const snippet of lawSnippets) {
        const body = String(snippet?.text || '').toLowerCase();
        if (body) bodyHas.add(body);
    }

    for (const term of pack.requiredDocTerms || []) {
        /*
         * A term is satisfied either by a fetched snippet that **is** that document, or — for a
         * snippet whose metadata carries no id — by the term appearing in its body. The second
         * branch is what the scored path always relied on (`scoreSufficiency` counts `lawHit` the
         * same way), so gaps and score keep agreeing about what a pack requires (A1, F44).
         */
        const slug = foldSlug(term);
        const byDoc = resolvedDocs.has(slug);
        const t = String(term).toLowerCase();
        const byBody = !byDoc && lawText.includes(t) && [...bodyHas].some((b) => b.includes(t));
        if (!byDoc && !byBody) {
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
 * Every term a pack needs law text for: the queries it names, plus every required term.
 *
 * `detectGaps` compares `requiredDocTerms` against the fetched law text, so a term that is only in
 * `requiredDocTerms` must still be fetched or its gap is unclosable (H4). Order is preserved and
 * duplicates are removed, so `trace` reads in the order the pack declared them.
 *
 * @param {object} pack
 * @returns {string[]}
 */
export function lawTermsFor(pack) {
    const seen = new Set();
    const terms = [];
    for (const term of [...(pack?.lawQueries || []), ...(pack?.requiredDocTerms || [])]) {
        const t = String(term || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        terms.push(t);
    }
    return terms;
}

/**
 * COLLECT — adapter registry + gap measure.
 * @param {object} input
 * @param {{ policy: object, eso: object, surface: object, stem: string, root?: string, reads?: object, registry?: object, injectSnippets?: object[] }} ctx
 */
export async function runCollect(input, ctx) {
    /*
     * The consumer's `.harness/skill-packs.json` is the pack source; the policy's `skillPacks` map is a
     * legacy fallback. Loaded here (not by the caller) so every path into COLLECT — hook, sidecar,
     * HTTP projection, DSH plugin — reads the same file and cannot disagree about what a bucket needs.
     * `ctx.skillPacks` is an explicit override, which is how a test or a host shim supplies packs
     * without touching disk.
     */
    const manifestPacks = ctx.skillPacks ?? (ctx.root ? loadSkillPacks({ root: ctx.root }).packs : parseSkillPacks(undefined));
    const pack = resolveSkillPack(ctx.surface, ctx.policy || ctx.eso, manifestPacks);
    const registry = ctx.registry || createSourceRegistry(ctx.policy);
    const snippets = [...(ctx.injectSnippets || [])];
    const trace = [];
    const lawMisses = [];

    const lawAdapter = registry.resolve('law');
    if (lawAdapter) {
        /*
         * Fetch every term `detectGaps` will check, not only `lawQueries` (H4).
         *
         * The two lists are not the same: `tools` requires `harness-eso` but only queries
         * `harness-tooling` / `decision-facade`. A required term that is never fetched can never
         * appear in `lawText`, so its gap is emitted every turn and **cannot be closed** — which is
         * exactly the `law:harness-eso` gap left open on `atrievefin` while the other two closed.
         */
        for (const q of lawTermsFor(pack)) {
            const r = await lawAdapter.fetch({ query: q, type: 'doc' }, { root: ctx.root, policy: ctx.policy });
            trace.push(r.trace);
            if (Array.isArray(r.snippets) && r.snippets.length > 0) snippets.push(...r.snippets);
            /*
             * The adapter answered with **nothing**, and that is a fact about the corpus, not about
             * the turn (G-02). It is recorded so the projection can name the gap as unanswerable
             * instead of leaving it indistinguishable from "the agent has not read it yet".
             */
            else if (String(r.trace || '').endsWith(`:miss:${q}`)) lawMisses.push(q);
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
        const memQ = ctx.stem || pack.lawQueries?.[0] || 'harness context';
        const r = await memoryAdapter.fetch(memQ, {
            root: ctx.root,
            policy: ctx.policy,
            conversationId: ctx.conversationId ?? input?.conversationId,
            surface: ctx.surface,
        });
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
    /*
     * Name the gaps that **no reading in this repo can close** (G-02).
     *
     * A `law` gap closes only on a path stem or on a `docgraph`/`Grep` query naming the term
     * (`closesGap`). When the law adapter already answered with nothing, nothing the agent can read
     * will produce that term, so the gap is not "unread" — it is unanswerable. Marking it lets the
     * projection and the deny message say so, instead of reporting the same denial it would report
     * for a turn that never tried.
     *
     * Not a removal: the gap stays required (`R6` in the defect register). A gate that stops asking
     * would never notice a genuinely unread document.
     */
    const unanswerable = new Set(lawMisses);
    for (const g of gaps) {
        if (g.kind === 'law' && unanswerable.has(g.query)) g.unanswerable = true;
    }
    const measure = scoreSufficiency(pack, retrieval, gaps, stem, ctx.eso.thresholds);

    return { pack, retrieval, gaps, measure, lawMisses };
}
