#!/usr/bin/env node
/**
 * Keep the diagram compilation in sync with the diagrams the product actually renders.
 *
 * Four diagrams live in `packages/harness-console/src/diagrams/pipeline-diagrams.ts` and are rendered by the
 * Console wizard. They are also copied into `documents/06.diagrams/01.diagrams-mermaid.md` so that one file
 * holds every diagram — that copy is the point of the compilation, but a copy drifts.
 *
 * So the copy is **checked**, not trusted:
 *
 *   node scripts/sync-diagrams.mjs            # verify; exit 1 on drift
 *   node scripts/sync-diagrams.mjs --write    # copy source → doc (the fix)
 *
 * The doc marks each copied block with an anchor the parser can find:
 *
 *   <!-- product-diagram: v2-abcd -->
 *   ```mermaid
 *   …
 *   ```
 *
 * Anchored rather than positional, so reordering sections in the doc cannot silently pair a block with the
 * wrong source — which is the failure mode that would make this check worse than useless.
 *
 * `qc/diagram-parity.test.mjs` calls the same comparison, so `bun run test` catches drift too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_FILE = path.join(
    REPO,
    'packages/harness-console/src/diagrams/pipeline-diagrams.ts',
);
export const DOC_FILE = path.join(REPO, 'documents/06.diagrams/01.diagrams-mermaid.md');

/**
 * The `mermaid:` template literals in the source, keyed by diagram id.
 *
 * Parsed rather than imported: the file is TypeScript, and a documentation check must not require a
 * build step or a compiler to answer "is the doc still true".
 *
 * @returns {Map<string, string>}
 */
export function readSourceDiagrams() {
    const src = fs.readFileSync(SOURCE_FILE, 'utf8');
    const out = new Map();
    // `'<id>': { … mermaid: `…` }` — the id is the record key, the block is a backtick literal.
    const recordRe = /'([a-z0-9-]+)':\s*\{[\s\S]*?mermaid:\s*`([\s\S]*?)`,\n\s*\}/g;
    for (const m of src.matchAll(recordRe)) {
        out.set(m[1], m[2].replace(/\s+$/, ''));
    }
    return out;
}

/** @returns {Map<string, string>} the anchored blocks in the doc, keyed by the same ids */
export function readDocDiagrams() {
    const doc = fs.readFileSync(DOC_FILE, 'utf8');
    const out = new Map();
    const re = /<!--\s*product-diagram:\s*([a-z0-9-]+)\s*-->\s*\n+```mermaid\n([\s\S]*?)```/g;
    for (const m of doc.matchAll(re)) {
        out.set(m[1], m[2].replace(/\s+$/, ''));
    }
    return out;
}

/** Normalise for comparison: trailing whitespace and blank-line runs are not drift. */
function normalize(s) {
    return String(s)
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/**
 * @returns {{ id: string, status: 'ok'|'drift'|'missing-in-doc'|'missing-in-source' }[]}
 */
export function compareDiagrams() {
    const source = readSourceDiagrams();
    const doc = readDocDiagrams();
    const ids = [...new Set([...source.keys(), ...doc.keys()])].sort();
    return ids.map((id) => {
        if (!source.has(id)) return { id, status: 'missing-in-source' };
        if (!doc.has(id)) return { id, status: 'missing-in-doc' };
        const same = normalize(source.get(id)) === normalize(doc.get(id));
        return { id, status: same ? 'ok' : 'drift' };
    });
}

/** Rewrite the doc's anchored blocks from the source, in place. */
export function writeDocDiagrams() {
    const source = readSourceDiagrams();
    let doc = fs.readFileSync(DOC_FILE, 'utf8');
    let written = 0;
    const re = /(<!--\s*product-diagram:\s*([a-z0-9-]+)\s*-->\s*\n+```mermaid\n)([\s\S]*?)(```)/g;
    doc = doc.replace(re, (_all, head, id, _body, fence) => {
        const next = source.get(id);
        if (next === undefined) return _all;
        written += 1;
        return `${head}${next}\n${fence}`;
    });
    fs.writeFileSync(DOC_FILE, doc);
    return { written };
}

/** CLI: verify by default, `--write` to repair. */
if (import.meta.main) {
    const write = process.argv.includes('--write');
    if (write) {
        const { written } = writeDocDiagrams();
        console.log(`  synced ${written} product diagram(s) into the doc`);
        process.exit(0);
    }
    const results = compareDiagrams();
    const bad = results.filter((r) => r.status !== 'ok');
    for (const r of results) {
        console.log(`  ${r.status === 'ok' ? 'ok   ' : 'DRIFT'}  ${r.id}${r.status === 'ok' ? '' : `  (${r.status})`}`);
    }
    if (bad.length) {
        console.error(`\n${bad.length} diagram(s) out of sync — run: bun run sync:diagrams --write`);
        process.exit(1);
    }
    console.log(`\n  all ${results.length} product diagram(s) in sync`);
}
