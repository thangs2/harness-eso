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
        const spec = query && typeof query === 'object' ? query : { query };
        const q = String(spec.text || spec.query || query || '').trim();
        if (!q) return { snippets: [], trace: 'docgraph:skip-empty' };
        const root = ctx.root || findRepoRoot();
        const max = ctx.maxChars ?? MAX_SNIPPET;
        const raw = fetchDocgraph(q, root, max);
        if (!raw) return { snippets: [], trace: `docgraph:miss:${q.slice(0, 40)}` };

        /*
         * A `requiredDocTerms` entry names a **document**, not a phrase, so the snippets have to say
         * which documents docgraph answered with. Without an id the only signal was the term
         * appearing in the body, which is why a required term could stay open forever while the law
         * answering it sat in the same result (H4).
         */
        const docIds = extractDocIds(raw);
        const { text, specDebt } = extractNormativeSpec(raw, max);
        return {
            snippets: [
                {
                    kind: 'law',
                    text,
                    query: q,
                    id: docIds[0] ?? null,
                    meta: { adapterId: 'docgraph-cli', specDebt, ...(specDebt ? {} : { docIds }) },
                },
            ],
            trace: `docgraph:ok:${q.slice(0, 40)}${specDebt ? ':spec_debt' : ''}`,
        };
    },
};

const DOC_PATH_RE = /(?:^|[\s(])((?:\.{0,2}\/)?[\w./-]+\.(?:md|mdc|json))\b/gi;

/**
 * Document paths docgraph named in its answer, most specific first.
 *
 * Docgraph's text output names the file each hit came from; the basename is the document id the
 * packs use when they say `harness-tooling` or `stack.fe.angular`.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function extractDocIds(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const out = [];
    const seen = new Set();
    for (const match of raw.matchAll(DOC_PATH_RE)) {
        const p = match[1].replace(/^\.{0,2}\//, '');
        if (!p || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}

/**
 * Extracts normative blocks (Invariants, Rules, Constraints, Alerts, bullet points)
 * and strips background prose and historical narratives.
 *
 * @param {string} rawMarkdown
 * @param {number} maxChars
 * @returns {{ text: string, specDebt: boolean }}
 */
export function extractNormativeSpec(rawMarkdown, maxChars = 1200) {
    if (!rawMarkdown || typeof rawMarkdown !== 'string') {
        return { text: '', specDebt: false };
    }

    const lines = rawMarkdown.split('\n');
    const normativeLines = [];
    let inNormativeSection = false;
    let foundNormativeMarker = false;

    for (const line of lines) {
        // Section header indicating invariants, rules, constraints, acceptance criteria
        if (/^#{1,4}\s+(invariants?|rules?|constraints?|acceptance criteria|security rules?)/i.test(line)) {
            inNormativeSection = true;
            foundNormativeMarker = true;
            normativeLines.push(line);
            continue;
        }

        // Another header breaks the normative section
        if (/^#{1,4}\s+/.test(line) && inNormativeSection) {
            inNormativeSection = false;
        }

        // GitHub alert blocks (> [!CRITICAL], > [!IMPORTANT], > [!WARNING])
        if (/^>\s*\[!(CRITICAL|IMPORTANT|WARNING|CAUTION)\]/i.test(line)) {
            foundNormativeMarker = true;
            normativeLines.push(line);
            continue;
        }

        // Lines inside an alert block (starts with >)
        if (normativeLines.length > 0 && normativeLines[normativeLines.length - 1].startsWith('>') && line.startsWith('>')) {
            normativeLines.push(line);
            continue;
        }

        // Invariant bullet points: - **INV-..., - **RULE-..., - **LAW-...
        if (/^\s*[-*]\s+\*\*(INV|LAW|RULE|SEC)-[A-Z0-9_-]+\*\*/i.test(line)) {
            foundNormativeMarker = true;
            normativeLines.push(line);
            continue;
        }

        // Lines inside normative section: keep structured items (bullets, numbers, tables, indented continuations)
        if (inNormativeSection) {
            if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^\s*\|/.test(line) || /^\s{2,}/.test(line)) {
                normativeLines.push(line);
            }
        }
    }

    // If normative blocks were identified, return them
    if (foundNormativeMarker && normativeLines.length > 0) {
        const text = normativeLines.join('\n').trim().slice(0, maxChars);
        return { text, specDebt: false };
    }

    // Fallback: No normative markers found (old/legacy document).
    // Return original snippet truncated to maxChars, but flag specDebt: true!
    return {
        text: rawMarkdown.trim().slice(0, maxChars),
        specDebt: true,
    };
}

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
