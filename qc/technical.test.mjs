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

    const api = walk(join(TECH, '03.api')).map(read).join('\n');
    const unreachable = [...ddl].filter((t) => !new RegExp(`\\b${t}\\b`).test(api)).sort();

    // `manifest_entry` is build output: it is written by the coverage builder, never through an API, so no endpoint
    // should reach it. It needs an `OUT` with that reason (OPEN-SCHEMA-02) rather than an invented route.
    assert.deepEqual(unreachable, ['manifest_entry'],
        'tables nothing can reach — each needs a path from an endpoint or an OUT with a reason');

    // The other direction: an endpoint naming a table nobody defined.
    const invented = [...api.matchAll(/`([a-z][a-z0-9_]{2,})`/g)]
        .map((m) => m[1])
        .filter((t) => /_/.test(t) && !ddl.has(t) && !t.includes('project') && !t.includes('role_') === false);
    assert.deepEqual([...new Set(invented)].filter((t) => t.startsWith('evidence_') || t.endsWith('_pack') || t === 'config_event' || t === 'sdlc_profile').filter((t) => !ddl.has(t)),
        [], 'table names an endpoint relies on that the schema does not define');
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
    const register = read(join(SDLC, '02.governance', '03.document-status.md'));

    const tables = new Set();
    for (const f of walk(join(TECH, '02.data-design'))) {
        for (const m of read(f).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) tables.add(m[1]);
    }
    const api = walk(join(TECH, '03.api')).map(read).join('\n');
    const endpoints = new Set([...api.matchAll(/^\| `(E\d+)` \|/gm)].map((m) => m[1]));

    const claim = (label) => {
        const m = new RegExp(`\\*\\*?(\\d+)\\*?\\*? ?${label}`).exec(register);
        return m ? Number(m[1]) : null;
    };
    assert.equal(claim('endpoint'), endpoints.size, 'the register disagrees with the endpoint catalogue');
    assert.equal(claim('bảng có DDL'), tables.size, 'the register disagrees with the schema');
});
