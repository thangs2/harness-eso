// X9 · X10 · X21 — the technical tree: contracts, data, and the naming law.
//
// The register claimed X9 and X10 were green. Both were measured by hand, once, and the numbers had drifted a whole
// restructuring behind: X9 said "20 endpoints · 15 tables · 3 tables with no path" when the tree had 22 endpoints,
// 17 tables and one orphan. X10 said "23/23" while 41 files in `02.data-design` and `03.api` had no revision rule at
// all — the check only looked at `01.architecture/`. A check whose scope is narrower than the thing it certifies is
// not a check; it is a sentence with a tick beside it.
//
// X21 is new and exists because three naming breaches survived for the same reason: nothing counted. An unnumbered
// folder, a duplicated `03.`, and a gap where an `18` should be are all invisible to a reader and trivial to a machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');
const TECH = join(SDLC, '07.technical');
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');

function walk(dir, out = []) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (n.endsWith('.md')) out.push(p);
    }
    return out;
}
const docs = (dir) => (existsSync(dir) ? walk(dir).filter((f) => !f.endsWith('00.index.md')) : []);
const dirs = (dir) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());

test('X9: every table has a path from an endpoint, or a recorded OUT', () => {
    const ddl = new Set();
    for (const f of walk(join(TECH, '02.data-design'))) {
        for (const m of read(f).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) ddl.add(m[1]);
    }
    assert.ok(ddl.size >= 16, `expected the schema to declare its tables, saw ${ddl.size}`);

    // The binding source is `02.roundtrip` §1 — one row per endpoint saying which tables it reads or writes. Scanning
    // every api file for a table name was too loose: a sentence that says "this table has no path" counted as a path.
    const roundtrip = read(join(TECH, '03.api', '02.roundtrip.md'));
    const at = roundtrip.search(/^## 1\./m);
    assert.notEqual(at, -1, '02.roundtrip must have a §1 binding table');
    const rest = roundtrip.slice(at + 1);
    const end = rest.search(/^## /m);
    const section = end === -1 ? rest : rest.slice(0, end);
    const named = new Set([...section.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1]));
    const unreachable = [...ddl].filter((t) => !named.has(t)).sort();

    assert.deepEqual(unreachable, ['manifest_entry'],
        'tables nothing can reach — each needs a path from an endpoint or an OUT with a reason');

    // The inverse direction cannot be read out of the binding cells — they mix tables, projections and output shapes
    // (`impact`), and the old version carried a hardcoded allow of `evidence_*` / `*_pack` names, which is the mark of
    // a check that never worked. The machine-readable invariant is the hub index instead: `02.schema` §2 lists one row
    // per table, and that list and the DDL must agree. This is exactly the failure `memory_fact` represented — a name
    // that lived in every list except the schema, and then in the schema but nowhere real.
    const hub = read(join(TECH, '02.data-design', '02.schema.md'));
    const hubTables = new Set([...hub.matchAll(/^\| \d+ \| `([a-z_]+)` \|/gm)].map((m) => m[1]));
    assert.deepEqual([...hubTables].sort(), [...ddl].sort(),
        'the schema hub index and the CREATE TABLE statements disagree');
});

test('X10: every technical document states what change makes it wrong', () => {
    const missing = [];
    for (const folder of ['01.architecture', '02.data-design', '03.api']) {
        for (const f of docs(join(TECH, folder))) {
            if (!/^## Luật sửa/m.test(read(f))) missing.push(rel(f));
        }
    }
    assert.deepEqual(missing, [], 'documents with no revision rule — they can drift without anything noticing');
});

test('X21: numbering is gapless and names are kebab-case', () => {
    const bad = [];
    const check = (dir) => {
        const files = readdirSync(dir).filter((n) => n.endsWith('.md'));
        const nums = [];
        for (const n of files) {
            if (n === 'README.md') continue;
            const m = /^(\d\d)\.([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(n);
            if (!m) { bad.push(`${rel(join(dir, n))} — not {NN}.{kebab-case}.md`); continue; }
            nums.push(Number(m[1]));
        }
        if (!nums.length) return;
        const gaps = [];
        for (let i = 0; i <= Math.max(...nums); i += 1) if (!nums.includes(i)) gaps.push(i);
        if (gaps.length) bad.push(`${rel(dir)} — numbering has no ${gaps.map((g) => `\`${String(g).padStart(2, '0')}\``).join(' · ')}`);
        const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
        if (dupes.length) bad.push(`${rel(dir)} — number used twice: ${[...new Set(dupes)].join(', ')}`);
        // folders are numbered in their own sequence, gapless among folders
        const subs = dirs(dir);
        if (subs.length) {
            const snums = [];
            for (const s of subs) {
                const m = /^(\d\d)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(s);
                if (!m) { bad.push(`${rel(join(dir, s))}/ — folder not numbered`); continue; }
                snums.push(Number(m[1]));
            }
            for (let i = 1; i <= Math.max(...snums); i += 1) if (!snums.includes(i)) bad.push(`${rel(dir)} — folder numbering has no \`${String(i).padStart(2, '0')}\``);
        }
    };
    walk(TECH).forEach((f) => {});
    for (const d of [TECH, ...dirs(TECH).map((n) => join(TECH, n))]) check(d);
    for (const n of dirs(TECH)) for (const s of dirs(join(TECH, n))) check(join(TECH, n, s));
    assert.deepEqual(bad, [], 'naming or numbering breaches');
});

test('X24: the status register states the counts the tree actually has', () => {
    // The register drifted twice in one day: it said "22 endpoints / 17 tables" after the tree had 27 and 19.
    // A number written by hand into a status table is a claim, and an unchecked claim is a guess with a tick.
    const register = read(join(ROOT, 'project', '01.governance', '01.document-status.md'));

    const tables = new Set();
    for (const f of walk(join(TECH, '02.data-design'))) {
        for (const m of read(f).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) tables.add(m[1]);
    }
    const api = walk(join(TECH, '03.api')).map(read).join('\n');
    const endpoints = new Set([...api.matchAll(/^\| `(API-\d+)` \|/gm)].map((m) => m[1]));

    const claim = (label) => {
        const m = new RegExp(`\\*\\*?(\\d+)\\*?\\*? ?${label}`).exec(register);
        return m ? Number(m[1]) : null;
    };
    assert.equal(claim('endpoint'), endpoints.size, 'the register disagrees with the endpoint catalogue');
    assert.equal(claim('bảng có DDL'), tables.size, 'the register disagrees with the schema');
});

test('X25: the boundary catalogue and the endpoint catalogue never share a name', () => {
    // Both used to be `E<n>`: `E6` meant "duplicate / replay" in an acceptance criterion and `GET /v1/health` in a
    // contract. Two closed lists with one alphabet is not ambiguity a careful reader can resolve — it is a defect
    // that survives every reader. Boundaries are now `ED<n>`, endpoints `API-<n>`; this check stops the old form
    // coming back one file at a time.
    const corpus = walk(SDLC).map(read).join('\n');

    const bareEdge = corpus.match(/\*\*E\d{1,2}\*\*/g) ?? [];
    assert.equal(bareEdge.length, 0, `a boundary still written **E<n>** — use **ED<n>**: ${bareEdge.slice(0, 5).join(', ')}`);

    const bareEndpoint = corpus.match(/`E\d{1,2}`/g) ?? [];
    assert.equal(bareEndpoint.length, 0, `an endpoint still written \`E<n>\` — use \`API-<n>\`: ${bareEndpoint.slice(0, 5).join(', ')}`);

    const artifacts = read(join(ROOT, 'standard', '02.artifacts.md'));
    const edges = [...artifacts.matchAll(/^\| \*\*(ED\d{1,2})\*\* \|/gm)].map((m) => m[1]);
    assert.deepEqual(edges, ['ED1', 'ED2', 'ED3', 'ED4', 'ED5', 'ED6', 'ED7', 'ED8', 'ED9', 'ED10'],
        'the boundary catalogue is a closed list of ten');
});

test('X26: every table block has a header and a delimiter row', () => {
    // A markdown table is only a table if its second line is the `|---|---|` delimiter. Rows that follow a blank line
    // or an inserted paragraph become a *new* block with no delimiter — and then they render as text with pipes, which
    // looks like a table to the author and like noise to the reader. Fourteen blocks were in that state, including the
    // cross-check register itself, where six rows had quietly dropped out of the table.
    const DELIMITER = /^\|[\s:|-]+\|$/;
    const broken = [];
    for (const f of walk(SDLC)) {
        const lines = read(f).split('\n');
        let i = 0;
        while (i < lines.length) {
            if (!lines[i].startsWith('|')) { i += 1; continue; }
            let j = i;
            while (j < lines.length && lines[j].startsWith('|')) j += 1;
            if (j - i >= 2 && !DELIMITER.test(lines[i + 1])) broken.push(`${rel(f)}:${i + 1}`);
            i = j;
        }
    }
    assert.deepEqual(broken, [], 'table blocks with no delimiter row — they do not render as tables');
});
