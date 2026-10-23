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
