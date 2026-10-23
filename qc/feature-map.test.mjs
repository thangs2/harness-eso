import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `documents/05.development/10.feature-and-classification-map.md` is a **table set**, not prose: its
 * whole value is that a reader can trust a row without opening the code. That trust is only worth
 * anything if the rows cannot drift.
 *
 * The defect this prevents is G-16 in the register — "the operator guide contradicts the shipped guard".
 * There, a sentence about a gate's decision input survived a change to that input, and the document kept
 * describing the old behaviour for as long as nobody read both. A table makes that drift worse, not
 * better, because a table is *more* believable than a paragraph.
 *
 * So the link is mechanical: every backticked path a row cites must exist, every register id must be in
 * the register, every tier/layer/plane/probe name must be defined on the page itself. This file asserts
 * that and nothing about the prose — a lint that tries to judge wording becomes the thing it lints.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'documents/05.development/10.feature-and-classification-map.md';
const REGISTER = 'documents/05.development/09.gate-defect-register.md';
const MATURITY = 'documents/04.operations/08.consumer-maturity-checklist.md';

const doc = fs.readFileSync(path.join(REPO, DOC), 'utf8');
const rows = doc
    .split('\n')
    .filter((l) => l.startsWith('| **'));

/** Paths cited in `code spans`, minus the ones that are consumer-side (they do not exist in this repo). */
function citedPaths(text) {
    const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    return spans.filter(
        (s) =>
            /^[\w./*-]+$/.test(s) &&
            !s.startsWith('.') &&
            !s.startsWith('~') &&
            !s.startsWith('HARNESS') &&
            !/^\d/.test(s) &&
            s.includes('/') &&
            /\.(mjs|py|json|tsx?|md)$|^packages\/[\w-]+\/src$/.test(s),
    );
}

/** Resolve a citation that may be a bare module name, a directory, or a glob. */
function resolves(p) {
    const abs = path.join(REPO, p);
    if (fs.existsSync(abs)) return true;
    // `collect.mjs` written without its directory resolves against any package's src.
    const base = path.basename(p);
    const dir = path.dirname(p);
    if (!dir.includes('/')) {
        for (const pkg of fs.readdirSync(path.join(REPO, 'packages'))) {
            if (fs.existsSync(path.join(REPO, 'packages', pkg, 'src', base))) return true;
        }
        return fs.existsSync(path.join(REPO, 'qc', base));
    }
    return false;
}

test('feature map: every cited path exists', () => {
    const missing = [];
    for (const row of rows) {
        for (const p of citedPaths(row)) {
            const clean = p.replace(/[*]$/, '').replace(/\/$/, '');
            if (!resolves(clean)) missing.push(`${p} ← ${row.slice(0, 60)}`);
        }
    }
    assert.deepEqual(missing, [], `cited paths that no longer exist:\n${missing.join('\n')}`);
});

test('feature map: every register id it cites is a row in the register', () => {
    const register = fs.readFileSync(path.join(REPO, REGISTER), 'utf8');
    const known = new Set([...register.matchAll(/\| \*\*(G-\d\d)\*\* \|/g)].map((m) => m[1]));
    assert.ok(known.size >= 16, `register parse found ${known.size} ids`);
    const cited = new Set([...doc.matchAll(/\bG-\d\d\b/g)].map((m) => m[0]));
    const missing = [...cited].filter((g) => !known.has(g));
    assert.deepEqual(missing, [], `cited but not in 09: ${missing.join(', ')}`);
});

test('feature map: every maturity tier it cites is defined in the maturity checklist', () => {
    const standard = fs.readFileSync(path.join(REPO, MATURITY), 'utf8');
    const defined = new Set([...standard.matchAll(/### (T\d) —/g)].map((m) => m[1]));
    assert.ok(defined.size >= 6, `maturity parse found ${[...defined].join(',')}`);
    const cited = new Set([...doc.matchAll(/\b(T[0-5])\b/g)].map((m) => m[1]));
    const missing = [...cited].filter((t) => !defined.has(t));
    assert.deepEqual(missing, [], `tiers cited but not in 04.operations/08: ${missing.join(', ')}`);
});

test('feature map: classification vocabulary is self-contained', () => {
    // Every plane / layer / enforcement value used in a table row must be defined in §2, so a reader
    // never has to follow a second document to decode a cell.
    for (const plane of ['control', 'observe']) {
        assert.match(doc, new RegExp(`\\| \\*\\*\\w+\\*\\* \\(\`${plane}\`\\) \\|`), `plane \`${plane}\` undefined in §2.1`);
    }
    // `both` is a row value, not a plane of its own; it is defined by its two halves.
    assert.match(doc, /\| \*\*Plane\*\*.*`control` · `observe` · `both`/, 'the `both` value must be in the axis table');
    for (const layer of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L_ingest']) {
        assert.match(doc, new RegExp(`\\| \\*\\*${layer}\\*\\* \\|`), `layer \`${layer}\` undefined in §2.2`);
    }
    for (const enf of ['deny', 'prompt-deny', 'report', 'none']) {
        assert.match(doc, new RegExp(`\\| \`${enf}\` \\|`), `enforcement \`${enf}\` undefined in §2.3`);
    }
});

test('feature map: probe ids are unique and each is defined once', () => {
    const defined = [...doc.matchAll(/\| \*\*(P-\d\d)\*\* \|/g)].map((m) => m[1]);
    assert.equal(new Set(defined).size, defined.length, `duplicate probe id: ${defined.join(',')}`);
    // Every probe referenced from the cross-index (§5) has a definition (§4).
    const cross = doc.split('## 5.')[1] || '';
    const referenced = new Set([...cross.matchAll(/\bP-\d\d\b/g)].map((m) => m[0]));
    const missing = [...referenced].filter((p) => !defined.includes(p));
    assert.deepEqual(missing, [], `probes referenced in §5 but not defined in §4: ${missing.join(', ')}`);
});

test('feature map: the two rows with no probe are named as defects, not left blank', () => {
    // §5's table is the reason this page exists: a row with no probe must say so, because "not
    // observable" is a finding and an empty cell is an omission. G-07 and G-15 are those rows.
    const section = doc.split('## 5.')[1].split('## 6.')[0];
    for (const id of ['G-07', 'G-15']) {
        const row = section.split('\n').find((l) => l.includes(`| ${id} |`));
        assert.ok(row, `${id} missing from the cross-index`);
        assert.match(row, /none|—/, `${id} must name the absence of a probe`);
    }
});

test('feature map: ownership is declared on every row and matches the ownership claims', () => {
    // §2.4 makes ownership per-row because the product and the consumer write to the same files. A row
    // without an owner is the silence that produced the 2026-10-23 confusion: "does the provision or the
    // init-config decide this?" had no answer anywhere in the repo.
    // §3 rows only: §3.6 also starts `| **F-xx** |`, so scope by section or this parses blast-radius
    // rows as feature rows and reads the impact cell as an ownership cell.
    const section3 = doc.split('### 3.6')[0];
    const featureRows = section3.split('\n').filter((l) => /^\| \*\*F-[A-Z]+\*\* \|/.test(l));
    assert.ok(featureRows.length >= 20, `parsed ${featureRows.length} feature rows`);
    // Vocabulary must be declared in the axes table (§1), where `both` is asserted, not in the detail
    // table (§2.4) — the detail table explains the values, the axis table must list them.
    const vocab = /\| \*\*Ownership\*\*.*`product` · `consumer` · `shared`/;
    assert.match(doc.split('## 2.')[0], vocab, 'the `product` · `consumer` · `shared` values must be in the axis table');
    const missing = [];
    const bad = [];
    for (const row of featureRows) {
        /*
         * Parse positionally, not by cell count: a Feature cell may contain `·` (F-ES: "never writes the
         * live stamp") and a lever cell contains `· T2`, so counting `·` would split prose. The ownership
         * cell is fixed relative to the start of the row: `| **F-ID** | feature | ownership | lever…`,
         * so splitting the row prefix is stable even when later cells change wording.
         */
        const id = row.match(/\*\*(F-[A-Z]+)\*\*/)[1];
        const ownership = row.split('** | ')[1]?.split(' | ')[1]?.trim();
        if (!ownership) missing.push(id);
        else if (!/^`(product|consumer|shared)`$/.test(ownership)) bad.push(`${id}: ${ownership}`);
    }
    assert.deepEqual(missing, [], `feature rows without an ownership cell: ${missing.join(', ')}`);
    assert.deepEqual(bad, [], `ownership cell must be exactly one of product/consumer/shared:\n${bad.join('\n')}`);
});

test('feature map §3.6: every table row has the same width as its header', () => {
    // The 2026-10-23 breakage: two cells in the blast-radius table contained an escaped `\|` in prose
    // ("`fail_closed` \| `off`"), which renders as a cell divider — the row grew a column and every row
    // after it shifted. Markdown has no error for this; it just draws a wrong table. A parser is the
    // only check that survives editing, so this test counts pipes per row inside every fenced-free table.
    const lines = doc.split('\n');
    const problems = [];
    let headerPipes = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.startsWith('|')) {
            headerPipes = 0;
            continue;
        }
        // A table row's cell count is `pipes - 1`. The separator row (`|---|---|`) declares the column
        // count, so read the header from the row *before* it — otherwise the separator (always 7 pipes
        // for 6 columns) becomes the reference and every real row looks short by one.
        const next = lines[i + 1] || '';
        const pipes = line.split('|').length - 1;
        if (/^\|[\s:|-]+\|$/.test(line)) {
            /*
             * Separator: it **is** the declaration — a GFM table uses the separator's cell count, and a
             * header with more cells than its separator silently loses columns (2026-10-23: the Ownership
             * column was added to five headers and to none of the separators, so `| ID |` to `| Trigger |`
             * rendered as five columns and every row spilled).
             */
            if (headerPipes && pipes !== headerPipes) {
                problems.push(`line ${i + 1}: separator has ${pipes} pipes, header has ${headerPipes}`);
            }
            headerPipes = pipes;
            continue;
        }
        if (/^\|[\s:|-]+\|$/.test(next)) {
            headerPipes = pipes;
            continue;
        }
        headerPipes = headerPipes || pipes;
        if (pipes !== headerPipes) problems.push(`line ${i + 1}: ${pipes} pipes, header has ${headerPipes}`);
    }
    assert.deepEqual(problems, [], `rows whose pipe count differs from their table header:\n${problems.join('\n')}`);
});

/**
 * §3.6 is a **graph**, and a graph written by hand drifts in exactly one way: an edge is added on one
 * side only. That is not a cosmetic defect — it is how someone edits F-GW without knowing F-HL reads it.
 * So the edges are parsed and checked in both directions, not just for spelling.
 */
function blastRows() {
    // Split on the NEXT heading, not on `---`: the first table's rows are separated from prose by a
    // blank line, but the section itself starts with prose containing `---`-free text; splitting on a
    // horizontal rule would also cut at the `|---|---|` separator and return nothing.
    const section = doc.split('### 3.6')[1]?.split('## 4.')[0] || '';
    return section
        .split('\n')
        .filter((l) => /^\| \*\*F-[A-Z]+\*\* \|/.test(l))
        .map((l) => {
            const cells = l.split(' | ');
            const id = l.match(/\*\*(F-[A-Z]+)\*\*/)[1];
            const ids = (cell) => [...(cell || '').matchAll(/\bF-[A-Z]+\b/g)].map((m) => m[0]);
            return {
                id,
                // cells[0] is `'| **F-ID**'` — the leading pipe splits into its own first element.
                detail: (cells[1] || '').trim(),
                impact: ids(cells[2]),
                affectedBy: ids(cells[3]),
                guard: cells[4] || '',
                row: l,
            };
        });
}

test('feature map §3.6: every feature has a blast-radius row, and every row is a real feature', () => {
    const section3 = doc.split('### 3.6')[0];
    const features = new Set([...section3.matchAll(/^\| \*\*(F-[A-Z]+)\*\* \|/gm)].map((m) => m[1]));
    const rows = blastRows();
    assert.ok(rows.length >= 20, `parsed ${rows.length} blast rows`);
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate blast row: ${ids.join(',')}`);
    assert.deepEqual([...features].filter((f) => !ids.includes(f)), [], 'features with no blast row');
    assert.deepEqual(ids.filter((i) => !features.has(i)), [], 'blast rows naming a non-feature');
});

test('feature map §3.6: impact and affectedBy are symmetric', () => {
    // A→B must appear as B←A. A one-way edge tells one editor to check the other side and not the reverse.
    const byId = new Map(blastRows().map((r) => [r.id, r]));
    const asymmetric = [];
    for (const row of byId.values()) {
        for (const target of row.impact) {
            const other = byId.get(target);
            if (!other) asymmetric.push(`${row.id} → ${target} (no such row)`);
            else if (!other.affectedBy.includes(row.id)) asymmetric.push(`${row.id} → ${target}, but ${target} does not list ${row.id}`);
        }
        for (const source of row.affectedBy) {
            const other = byId.get(source);
            if (!other) asymmetric.push(`${row.id} ← ${source} (no such row)`);
            else if (!other.impact.includes(row.id)) asymmetric.push(`${row.id} ← ${source}, but ${source} does not list ${row.id}`);
        }
    }
    assert.deepEqual(asymmetric, [], `one-way blast edges:\n${asymmetric.join('\n')}`);
});

test('feature map §3.6: every row states a detail, a guard that exists, and a reason', () => {
    const problems = [];
    for (const r of blastRows()) {
        if (!r.detail || r.detail.length < 20) problems.push(`${r.id}: detail missing or too thin`);
        // Guard cell is `path · why`. The path must exist on disk — a stale test citation is worse than
        // none, because it looks like coverage.
        const guardPath = (r.guard.match(/`([^`]+\.(?:mjs|py|tsx?))`/) || [])[1];
        if (!guardPath) problems.push(`${r.id}: no test path in the guard column`);
        else if (!fs.existsSync(path.join(REPO, guardPath))) problems.push(`${r.id}: guard path missing → ${guardPath}`);
        if (!/·/.test(r.guard)) problems.push(`${r.id}: guard column must also carry the reason after "·"`);
    }
    assert.deepEqual(problems, [], `blast rows missing their contract:\n${problems.join('\n')}`);
});

test('feature map §3.6: every stated reason cites something that exists', () => {
    // "Why" is the column that stops a future editor from "simplifying" a deliberate decision. A citation
    // to a register id that does not exist is worse than no citation: it reads as precedent.
    const register = fs.readFileSync(path.join(REPO, REGISTER), 'utf8');
    const known = new Set([...register.matchAll(/\*\*(G-\d\d|R\d)\*\*/g)].map((m) => m[1]));
    assert.ok(known.size >= 20, `register parse found ${known.size} ids`);
    const problems = [];
    for (const r of blastRows()) {
        const cited = [...new Set([...r.guard.matchAll(/\b(G-\d\d|R\d)\b/g)].map((m) => m[1]))];
        for (const id of cited) if (!known.has(id)) problems.push(`${r.id}: cites ${id}, absent from 09`);
        if (!cited.length && !/Design:/.test(r.guard)) problems.push(`${r.id}: states no reason (no G-/R- and no "Design:")`);
    }
    assert.deepEqual(problems, [], `reasons that cite nothing real:\n${problems.join('\n')}`);
});
