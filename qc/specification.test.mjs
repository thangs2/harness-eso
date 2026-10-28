// X16–X20 — the stage-1 specification family: PRD · BRD · FRD · SRS.
//
// The rule lives in sdlc/02.governance/03.document-status.md §3. Before these checks existed the four
// documents were judged only by "has frontmatter and a non-empty body", so a whole document type could go
// missing, a function could ship without a spec, and an NFR could be written with no way to measure it —
// and nothing turned red. X7 states that limit itself: its verdict on judgement types is evidence, not a gate.
//
// Each check below is a command that returns a count, not an opinion. When one fails it names the file or
// the id, because "the spec family is incomplete" is not actionable and "F-19 has no FRD file" is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');
const SPEC = join(SDLC, '05.requirements', '01.specification');
const rel = (p) => relative(ROOT, p);

const read = (p) => readFileSync(p, 'utf8');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith('.md')) out.push(p);
    }
    return out;
}

/** Frontmatter keys, same parse as the X7 gate so the two agree on what a document declares. */
function keys(file) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(read(file));
    const out = {};
    if (!fm) return out;
    for (const line of fm[1].split('\n')) {
        const m = /^([a-z_]+):\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
    return out;
}

const TYPE_DIR = { prd: '01.prd', brd: '02.brd', frd: '03.frd', srs: '04.srs' };
const ofType = (type) => {
    const dir = join(SPEC, TYPE_DIR[type]);
    return existsSync(dir) ? walk(dir) : [];
};
/** Content files only — `00.index.md` is navigation, not an artifact. */
const content = (type) => ofType(type).filter((f) => !f.endsWith('00.index.md'));

test('X16: the four specification documents exist, and nothing hides inside them', () => {
    const missing = [];
    for (const [type, dir] of Object.entries(TYPE_DIR)) {
        const full = join(SPEC, dir);
        if (!existsSync(full)) { missing.push(`${dir}/ — the whole ${type.toUpperCase()} is absent`); continue; }
        if (!existsSync(join(full, '00.index.md'))) missing.push(`${dir}/00.index.md — no index`);
        if (content(type).length === 0) missing.push(`${dir}/ — index with nothing behind it`);
    }
    assert.deepEqual(missing, [], 'a specification document is missing');

    // An artifact the index never links is an artifact nobody reads. The index is the entry point or it is not.
    const orphan = [];
    for (const type of Object.keys(TYPE_DIR)) {
        const idx = join(SPEC, TYPE_DIR[type], '00.index.md');
        if (!existsSync(idx)) continue;
        const index = read(idx);
        for (const f of content(type)) {
            const base = f.split('/').pop();
            if (!index.includes(base)) orphan.push(`${TYPE_DIR[type]}/${base}`);
        }
    }
    assert.deepEqual(orphan, [], 'files an index never links — unreachable by reading');
});

test('X17: every vision goal has a metric, and every metric measures something', () => {
    const vision = read(join(SDLC, '03.inception', '01.vision', '01.vision-mission-goals.md'));
    const goals = new Set([...vision.matchAll(/^### (G-[A-F])\b/gm)].map((m) => m[1]));
    assert.ok(goals.size >= 6, `expected the vision to declare its goals, saw ${goals.size}`);

    const metricsFile = join(SPEC, '01.prd', '06.success-metrics.md');
    const rows = read(metricsFile).split('\n').filter((l) => /^\|\s*`MET-\d+`/.test(l));
    assert.ok(rows.length > 0, 'the PRD has no metric rows');

    const measured = new Set();
    const unmeasurable = [];
    for (const row of rows) {
        const cells = row.split('|').slice(1, -1).map((c) => c.trim());
        const id = cells[0].replace(/`/g, '');
        const goal = (cells[4] ?? '').trim();
        if (goals.has(goal)) measured.add(goal);
        // A metric with no way to measure it is a wish, not a metric.
        if (!cells[2] || cells[2] === '—') unmeasurable.push(`${id} — no measurement`);
        if (!cells[3] || cells[3] === '—') unmeasurable.push(`${id} — no threshold`);
    }
    assert.deepEqual(unmeasurable, [], 'metrics that cannot be measured');

    const unserved = [...goals].filter((g) => !measured.has(g)).sort();
    assert.deepEqual(unserved, [], 'goals with no metric — nobody will know if it was reached');
});

test('X18: every function has exactly one FRD file, and each file is a real spec', () => {
    const features = new Set(
        [...read(join(SDLC, '06.analysis', '01.business-analysis', '06.eso-features.md')).matchAll(/\*\*(F-\d\d)\*\*/g)]
            .map((m) => m[1]),
    );
    assert.ok(features.size > 0, 'the feature catalogue declares no function');

    // Identity comes from the header, not the filename: the folder already says FRD, so the name must not
    // repeat it. Compared on a normalised form because the catalogue writes `F-01` and the id `FRD-F01`.
    const norm = (s) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const byId = new Map();
    for (const f of content('frd')) {
        const id = keys(f).id ?? '';
        const m = /^FRD-(F-?\d\d)$/.exec(id);
        if (!m) { byId.set(`?${rel(f)}`, f); continue; }
        const k = norm(m[1]);
        if (byId.has(k)) byId.set(`${k}+dup:${rel(f)}`, f);
        else byId.set(k, f);
    }

    const noFile = [...features].filter((f) => !byId.has(norm(f))).sort();
    assert.deepEqual(noFile, [], 'functions with no FRD file — behaviour described and specified nowhere');

    const known = new Set([...features].map(norm));
    const noFunction = [...byId.keys()].filter((k) => !known.has(k) && !k.includes('+dup') && !k.startsWith('?')).sort();
    assert.deepEqual(noFunction, [], 'FRD files for a function the catalogue does not declare');

    const thin = [];
    for (const f of features) {
        const file = byId.get(norm(f));
        if (!file) continue;
        const text = read(file);
        for (const n of [1, 2, 3, 4, 5, 6]) {
            if (!new RegExp(`^## ${n}\\. `, 'm').test(text)) thin.push(`${rel(file)} — missing §${n}`);
        }
        // The rejection section is the point: a function that refuses nothing cannot be tested negatively.
        const rej = text.split(/^## 4\. /m)[0].split(/^## 3\. /m)[1] ?? '';
        if (!/^\s*- /m.test(rej)) thin.push(`${rel(file)} — §3 names no rejection condition`);
    }
    assert.deepEqual(thin, [], 'FRD files that are not specifications');

    // A namespace with no FRD is a whole group of behaviour with no functional spec. The allowance used to be
    // ['UI'] — the 61 criteria behind the five surfaces, recorded as OPEN-FRD-01. Those now have five FRD files,
    // so the allowance is empty: any uncovered namespace from here is a new gap, not a known one.
    const declared = new Set();
    for (const f of content('frd')) {
        const header = read(f).split('\n').find((l) => l.includes('**Nhóm `AC`:**')) ?? '';
        for (const m of header.matchAll(/AC-([A-Z]+)\*/g)) declared.add(m[1]);
    }
    const used = new Set();
    for (const f of walk(join(SDLC, '06.analysis', '03.acceptance-criteria'))) {
        for (const m of read(f).matchAll(/\bAC-([A-Z]+)-\d\d-\d\d\b/g)) used.add(m[1]);
    }
    const uncovered = [...used].filter((p) => !declared.has(p)).sort();
    assert.deepEqual(uncovered, [], 'AC namespaces with no FRD file');
});

test('X19: the SRS carries NFRs that can be measured, and covers every REQ', () => {
    const srs = content('srs');
    const nfr = [];
    for (const f of srs) {
        for (const line of read(f).split('\n')) {
            if (!/^\|\s*`NFR-\d+`/.test(line)) continue;
            const cells = line.split('|').slice(1, -1).map((c) => c.trim());
            // A definition row has exactly four columns: id · statement · how measured · threshold.
            // Shorter rows are status summaries ("NFR-16 ✅ đang đo") and are not definitions.
            if (cells.length !== 4) continue;
            nfr.push({ id: cells[0].replace(/`/g, ''), how: cells[2], threshold: cells[3], file: rel(f) });
        }
    }
    assert.ok(nfr.length > 0, 'the SRS has no NFR at all — a functional-only spec is not an SRS');

    const bad = nfr
        .filter((n) => !n.how || n.how === '—' || !n.threshold || n.threshold === '—')
        .map((n) => `${n.id} in ${n.file} — ${!n.how ? 'no measurement' : 'no threshold'}`);
    assert.deepEqual(bad, [], 'NFRs that cannot be measured');

    // §3 of the SRS is an index onto the REQ shard. A REQ the SRS never names is a requirement the
    // specification quietly does not cover.
    const reqs = new Set(
        [...read(join(SDLC, '05.requirements', '04.requirements.md')).matchAll(/\*\*(REQ-[A-Z]+-\d\d)\*\*/g)]
            .map((m) => m[1]),
    );
    assert.ok(reqs.size > 0, 'the requirement shard declares no requirement');
    const srsFunctional = read(join(SPEC, '04.srs', '03.functional-requirements.md'));
    const uncovered = [...reqs].filter((r) => !srsFunctional.includes(r)).sort();
    assert.deepEqual(uncovered, [], 'requirements the SRS does not carry');
});

test('X20: the BRD carries every business rule and every actor authority', () => {
    const rules = new Set(
        [...read(join(SDLC, '06.analysis', '01.business-analysis', '03.business-rules.md')).matchAll(/\*\*(BR-\d\d)\*\*/g)]
            .map((m) => m[1]),
    );
    const brdRules = read(join(SPEC, '02.brd', '03.business-rules.md'));
    const noRule = [...rules].filter((r) => !brdRules.includes(r)).sort();
    assert.deepEqual(noRule, [], 'business rules the BRD does not carry');

    const actors = new Set(
        [...read(join(SDLC, '06.analysis', '01.business-analysis', '01.actors.md')).matchAll(/\*\*(A-\d\d)\*\*/g)]
            .map((m) => m[1]),
    );
    const authority = read(join(SPEC, '02.brd', '02.actors-authority.md'));
    const noActor = [...actors].filter((a) => !authority.includes(a)).sort();
    assert.deepEqual(noActor, [], 'actors the BRD does not give an authority row');

    // A row that states permission but not prohibition is half a rule: see BR-08 (only A-01 sets Done).
    const rows = authority.split('\n').filter((l) => /\*\*A-\d\d\*\*/.test(l));
    const halfRule = rows.filter((l) => !/cấm/i.test(l)).map((l) => l.split('|')[2]?.trim() ?? l);
    assert.deepEqual(halfRule, [], 'actor rows with no "bị cấm" column — permission without a boundary');
});
