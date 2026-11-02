// X7 — document shape conformance for the sdlc/ tree.
//
// The rule lives in sdlc/02.governance/01.standard/02.artifacts.md §2: every document kind has required sections.
// The check was manual twice (see sdlc/02.governance/03.x7-analysis.md); this test makes it a gate.
//
// It automates only what can be decided mechanically. "Heading equivalence" is encoded below as data so a
// disagreement becomes a one-line edit rather than an argument. Types whose required sections are prose
// judgements (standard, c4, decision-log, ...) are checked for frontmatter and a non-empty body only, and
// that limitation is stated in the report rather than hidden here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');
const read = (p) => readFileSync(p, 'utf8');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith('.md')) out.push(p);
    }
    return out;
}

function parse(file) {
    const text = readFileSync(file, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const keys = {};
    if (fm) {
        for (const line of fm[1].split('\n')) {
            const m = /^([a-z_]+):\s*(.*)$/.exec(line);
            if (m) {
                const value = m[2].trim().replace(/^"|"$/g, '');
                // A key whose value is a block list (`- item` lines) parses as an empty string;
                // record it so "declares allowed_files" is not confused with "has no entries".
                keys[m[1]] = value === '' ? '[]' : value;
            }
        }
    }
    return { text, type: keys.type, keys, body: fm ? text.slice(fm[0].length) : text };
}

// A required section is a name plus the heading shapes accepted for it. Adding a shape is a deliberate act.
const SECTION = {
    story: [/^## Story\b/m],
    whoseValue: [/^## Giá trị thật thuộc về ai\b/m, /^## Giá trị thuộc về\b/m],
    whyNotMerged: [/^## Vì sao[^\n]*/m, /^## Ranh giới với\b/m],
    inScope: [/^## Trong phạm vi\b/m],
    outOfScope: [/^## Ngoài phạm vi\b/m],
    plannedAC: [/^## AC\b/m, /^## AC dự kiến\b/m],
    postconditions: [/^## \d*\.?\s*Điều kiện sau\b/m, /^## Postconditions\b/m],
    tests: [/^## \d*\.?\s*Test\b/m],
    notChecked: [/^## \d*\.?\s*AC này \*\*không\*\* kiểm\b/m, /^## .*không kiểm\b/m],
    acTable: [/^\| ac_id \| type \|/m],
    scnTable: [/^\| scenario_id \| ac_ref \| type \|/m],
    marks: [/✅|⚠️|❌|\[ \]/],
    path: [/\.md`|\/[a-z0-9.-]+/i],
};

const RULES = {
    'user-story': ['story', 'whoseValue', 'whyNotMerged', 'inScope', 'outOfScope', 'plannedAC'],
    'acceptance-criteria': ['acTable', 'postconditions', 'tests', 'notChecked'],
    'scenario-matrix': ['scnTable'],
    'checklist': ['marks', 'path'],
};

// Types whose required sections are prose judgements, not headings. Listed so the omission is visible.
const JUDGEMENT = new Set([
    'standard', 'requirement', 'actor-catalog', 'use-case', 'business-rule', 'c4',
    'data-model', 'api-contract', 'ui-design', 'query-spec', 'wbs', 'bip', 'fip', 'architecture-doc',
    'decision-log', 'feature-catalog', 'traceability-matrix', 'domain-spec', 'capability-spec', 'capability-index',
    'brd',  // a business narrative: judged by whether it tells one true story, not by a fixed heading list
    'prd', 'frd', 'srs',  // stage-1 specification family: judged by whether every claim binds to a shard, not by headings
    'concept',  // a design concept: judged by whether it separates what is settled from what is open, not by headings
    'nfr-spec',  // thresholds and measurement: judged by whether every NFR can be met, not by headings

]);

const hasAll = (text, names) => names.every((n) => SECTION[n].some((re) => re.test(text)));

test('X7: every document declares a type the standard knows', () => {
    const unknown = [];
    const untyped = [];
    let n = 0;
    for (const f of walk(SDLC)) {
        if (f.endsWith('README.md')) continue;
        const { type } = parse(f);
        // A document with no type is not "not applicable" — it is a document the check cannot
        // judge. Skipping it silently would let an untyped file pass forever, which is how the
        // six c4 files went unnoticed.
        if (!type) { untyped.push(relative(ROOT, f)); continue; }
        n += 1;
        if (!(type in RULES) && !JUDGEMENT.has(type)) unknown.push(`${relative(ROOT, f)} → ${type}`);
    }
    assert.ok(n > 150, `expected the tree to be large, saw ${n} typed documents`);
    assert.deepEqual(untyped, [], 'documents with no type — no rule can be applied to them');
    assert.deepEqual(unknown, [], 'a document declares a type that has no rule in the standard');
});

test('X7: user stories carry whose-value, why-not-merged, scope, and planned AC', () => {
    const bad = [];
    for (const f of walk(join(SDLC, '06.analysis', '02.user-stories'))) {
        if (f.endsWith('README.md')) continue;
        const { type, text } = parse(f);
        if (type !== 'user-story') continue;
        if (!hasAll(text, RULES['user-story'])) bad.push(relative(ROOT, f));
    }
    assert.deepEqual(bad, []);
});

test('X7: acceptance criteria carry a table, postconditions, tests, and what they do not check', () => {
    const bad = [];
    for (const f of walk(join(SDLC, '06.analysis', '03.acceptance-criteria'))) {
        if (f.endsWith('README.md')) continue;
        const { type, text } = parse(f);
        if (type !== 'acceptance-criteria') continue;
        if (!hasAll(text, RULES['acceptance-criteria'])) bad.push(relative(ROOT, f));
    }
    assert.deepEqual(bad, []);
});

test('X7: scenario matrices carry the scenario table shape', () => {
    const bad = [];
    for (const f of walk(join(SDLC, '06.analysis', '04.quality-control'))) {
        if (f.endsWith('README.md')) continue;
        const { type, text } = parse(f);
        if (type !== 'scenario-matrix') continue;
        if (!hasAll(text, RULES['scenario-matrix'])) bad.push(relative(ROOT, f));
    }
    assert.deepEqual(bad, []);
});

test('X7: checklists mark each item and name an evidence path', () => {
    const bad = [];
    for (const f of walk(SDLC)) {
        const { type, text } = parse(f);
        if (type !== 'checklist') continue;
        if (!hasAll(text, RULES['checklist'])) bad.push(relative(ROOT, f));
    }
    assert.deepEqual(bad, []);
});

test('X7: every non-README document has frontmatter with a source and a status', () => {
    const bad = [];
    for (const f of walk(SDLC)) {
        if (f.endsWith('README.md')) continue;
        const { keys } = parse(f);
        if (!keys.type) continue;
        // HUMAN zone: sot_doc_version + status + a source. AI zone: sot_doc_version + human_sot (no status — std §1.1).
        const aiZone = Boolean(keys.human_sot);
        const missing = ['sot_doc_version'].filter((k) => !keys[k]);
        if (aiZone) {
            if (!keys.human_sot) missing.push('human_sot');
        } else {
            if (!keys.status) missing.push('status');
            if (!keys.source_of_truth) missing.push('source_of_truth');
        }
        if (missing.length) bad.push(`${relative(ROOT, f)} → ${missing.join(', ')}`);
    }
    assert.deepEqual(bad, []);
});

test('X7: no document carries two names for one header field', () => {
    // doc_kind/standard_version/stage were the older spellings. Keeping them beside the current
    // ones gives every reader two sources of truth and gives every check one it does not read.
    const RETIRED = { doc_kind: 'type', standard_version: 'sot_doc_version', stage: 'phase' };
    const bad = [];
    for (const f of walk(SDLC)) {
        const { keys } = parse(f);
        for (const [old, current] of Object.entries(RETIRED)) {
            if (keys[old] !== undefined) {
                bad.push(`${relative(ROOT, f)} → ${old} (use ${current})`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('X7: c4 declares its level, domain-spec declares its write boundary', () => {
    const bad = [];
    for (const f of walk(SDLC)) {
        const { keys } = parse(f);
        if (keys.type === 'c4' && !keys.level) bad.push(`${relative(ROOT, f)} → c4 without level`);
        if (keys.type === 'domain-spec') {
            const need = ['domain', 'owner_role', 'allowed_files', 'forbidden', 'human_sot'];
            const missing = need.filter((k) => !keys[k]);
            if (missing.length) bad.push(`${relative(ROOT, f)} → ${missing.join(', ')}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('X22: every OPEN in a packet section 8 is classified in the mapping register', () => {
    // This check exists because the number 175 circulated for weeks. It was produced by counting every `OPEN-<n>`
    // string inside section 8 — including the ones repeated in the explanatory tables under it. Counting strings is
    // not counting rows: the real figure was 106. A register that is not checked against the source drifts back.
    const map = read(join(SDLC, '06.analysis', '04.quality-control', '13.open-mapping.md'));
    const classified = new Set(
        [...map.matchAll(/^\| `([0-9a-z.-]+)` \| `(OPEN-\d+)` \|/gm)].map((m) => `${m[1]}|${m[2]}`),
    );
    assert.ok(classified.size > 0, 'the mapping register lists no rows');

    const live = [];
    for (const f of walk(join(SDLC, '09.wbs', '01.packets'))) {
        const packet = basename(f, '.md');
        const text = read(f);
        const start = text.search(/^##\s*8\./m);
        if (start === -1) continue;
        const rest = text.slice(start);
        const end = rest.slice(1).search(/^##\s/m);
        const section = end === -1 ? rest : rest.slice(0, end + 1);
        for (const m of section.matchAll(/^\|\s*\*\*`(OPEN-\d+)`\*\*\s*\|/gm)) {
            live.push(`${packet}|${m[1]}`);
        }
    }
    const unclassified = live.filter((k) => !classified.has(k));
    assert.deepEqual(unclassified, [], 'OPEN rows missing from the mapping register');
});

test('X23: every open packet item belongs to exactly one proposed decision', () => {
    // D-63 groups the 70 remaining OPENs into 14 decisions. Two lists now describe the same set from opposite sides:
    // 07.open-mapping §2 says what each OPEN waits for, D-63 §4 says which decision settles it. If they disagree, one
    // of them is lying — and the failure mode is an OPEN that nobody notices is unassigned.
    const section = (text, heading) => {
        const start = text.search(new RegExp(`^## ${heading}\\.`, 'm'));
        if (start === -1) return '';
        const rest = text.slice(start + 1);
        const end = rest.search(/^## /m);
        return end === -1 ? rest : rest.slice(0, end);
    };
    const row = /^\| `([0-9a-z.-]+)` \| `(OPEN-\d+)` \|/gm;
    const keys = (text) => [...text.matchAll(row)].map((m) => `${m[1]}|${m[2]}`).sort();

    const mapping = read(join(SDLC, '06.analysis', '04.quality-control', '13.open-mapping.md'));
    const decision = read(join(SDLC, '03.inception', '02.decision-log', '01.open-decisions.md'));

    const waits = keys(section(mapping, 2));
    const assigned = keys(section(decision, 4));

    // An empty §2 is the goal, not a failure: when every packet item is closed the waiting list is empty and both
    // sides must be empty together. The check still catches the real failure — one side listing something the other
    // does not.
    assert.deepEqual(waits.filter((k) => !assigned.includes(k)), [], 'OPENs with no proposed decision');
    assert.deepEqual(assigned.filter((k) => !waits.includes(k)), [], 'decisions naming an OPEN that is already closed');
});

test('X27: every document type in the tree is signed by someone', () => {
    // The owner table answers one question: if this artifact is wrong, who gets asked? Without it, "wrong" has no address —
    // and an artifact with no address is one nobody fixes. The table is also the only place that gives `kt-state: approved`
    // a meaning: only the owner of a kind may approve knowledge of that kind.
    //
    // A row is `| `kind` | ROLE |` — exactly two cells, unlike the type table next to it.
    const OWNER_ROW = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([A-Za-z/]+)\s*\|$/;
    const standard = read(join(ROOT, 'standard', '02.artifacts.md'));
    const owners = new Map();
    for (const line of standard.split('\n')) {
        const m = OWNER_ROW.exec(line);
        if (m) owners.set(m[1], m[2]);
    }
    assert.ok(owners.size > 20, `the owner table declares only ${owners.size} kinds — it is not being read`);

    const unsigned = new Map();
    for (const f of walk(SDLC)) {
        const m = /^type:\s*(\S+)$/m.exec(read(f));
        if (!m) continue;
        const type = m[1].replace(/["']/g, '');   // `type: "brd"` and `type: brd` name one kind, not two
        if (!owners.has(type)) unsigned.set(type, (unsigned.get(type) ?? 0) + 1);
    }
    const report = [...unsigned].map(([k, n]) => `${k} (${n} file) — nobody signs it`).sort();
    assert.deepEqual(report, [], 'document types with no owner in the standard');
});

test('X6: no criterion or scenario id is defined twice', () => {
    // The register said "no AC/SCN id defined in two files". Two files was too narrow in both directions: an id defined
    // twice in the *same* matrix is just as ambiguous, and a two-column "why this matters" table repeats ids on purpose.
    // A definition row is the wide one — six or more columns.
    const NAMES = [
        [join(SDLC, '06.analysis', '03.acceptance-criteria'), /^\| `(AC-[A-Z0-9-]+)`/],
        [join(SDLC, '06.analysis', '04.quality-control'), /^\| `(SCN-[A-Z0-9-]+)`/],
    ];
    const seen = new Map();
    for (const [dir, pattern] of NAMES) {
        for (const f of walk(dir)) {
            for (const line of read(f).split('\n')) {
                const m = pattern.exec(line);
                if (!m) continue;
                const cells = line.split('|').slice(1, -1);
                if (cells.length < 6) continue;                       // the rationale table, not a definition
                const where = relative(SDLC, f);
                seen.set(m[1], [...(seen.get(m[1]) ?? []), where]);
            }
        }
    }
    const twice = [...seen].filter(([, files]) => files.length > 1)
        .map(([id, files]) => `${id} → ${files.join(' + ')}`).sort();
    assert.ok(seen.size > 300, `found only ${seen.size} definitions — the scan is not reading the matrices`);
    assert.deepEqual(twice, [], 'ids defined more than once');
});

test('X12: every alternate flow carries an id, and an AC names it', () => {
    const BA = join(SDLC, '06.analysis', '01.business-analysis');
    const AC = join(SDLC, '06.analysis', '03.acceptance-criteria');
    const flows = new Set();
    for (const f of walk(BA)) for (const m of read(f).matchAll(/UC-\d+\.\d+[a-z]?/g)) flows.add(m[0]);
    assert.ok(flows.size > 0, 'no alternate flow carries an id at all — they cannot be tested');

    const named = walk(AC).map(read).join('\n');
    const untested = [...flows].filter((id) => !named.includes(id)).sort();
    assert.deepEqual(untested, [], 'alternate flows no criterion ever tests — a branch that was designed and never checked');
});

test('X14: a surface is designed only when it is prototyped', () => {
    const UI = join(SDLC, '08.ui-design');
    const surfaces = [...read(join(UI, '01.surfaces.md')).matchAll(/^\| \*\*(S\d)\*\*/gm)].map((m) => m[1]);
    assert.ok(surfaces.length > 0, 'the surface catalogue declares nothing');

    const wireframes = read(join(UI, '02.wireframes.md'));
    const states = read(join(UI, '03.states.md'));
    const flowFiles = walk(join(UI, '04.flows'));
    const bad = [];
    for (const s of surfaces) {
        if (!wireframes.includes(s)) bad.push(`${s}: no wireframe`);
        const section = new RegExp(`## [\\d.]* ?Ma trận ${s}\\n([\\s\\S]*?)(?=\\n## |$)`, 'g').exec(states);
        if (!section) { bad.push(`${s}: no state matrix`); continue; }
        const missing = [1, 2, 3, 4, 5, 6].filter((i) => !section[1].includes(`ST${i}`));
        if (missing.length) bad.push(`${s}: missing ${missing.map((i) => `ST${i}`).join(' ')}`);
        const flow = flowFiles.find((f) => f.includes(`s${s.slice(1)}-`));
        if (!flow || !read(flow).includes('AC-')) bad.push(`${s}: no flow that names a criterion`);
    }
    assert.deepEqual(bad.sort(), [], 'surfaces described by name but not designed');
});

test('X15: every UI criterion is reachable from a flow', () => {
    const AC = join(SDLC, '06.analysis', '03.acceptance-criteria');
    const defined = new Set();
    for (const f of walk(AC)) {
        for (const line of read(f).split('\n')) {
            const m = /^\| `(AC-UI-[A-Z0-9-]+)`/.exec(line);
            if (m) defined.add(m[1]);
        }
    }
    assert.ok(defined.size > 0, 'no UI criterion exists — X15 would pass vacuously');

    const flows = walk(join(SDLC, '08.ui-design', '04.flows')).map(read).join('\n');
    const unreachable = [...defined].filter((id) => !flows.includes(id)).sort();
    assert.deepEqual(unreachable, [], 'criteria that no flow step can reach — behaviour nothing walks through');
});

test('X2: every document declares where it came from, its status, and when it belongs', () => {
    // Two zones, two rules. AI-zone documents point at the human document that governs them (`human_sot`) because that is the
    // direction a reader travels; human documents carry the four provenance keys because that is what the gates read.
    const AI = join(SDLC, '01.agent-manifests');
    const need = (f) => (f.startsWith(AI)
        ? ['sot_doc_version', 'human_sot']
        : ['sot_doc_version', 'source_of_truth', 'status', 'phase']);
    const bad = [];
    for (const f of walk(SDLC)) {
        if (f.endsWith('README.md')) continue;                 // navigation, not an artifact
        const m = /^---\n([\s\S]*?)\n---/.exec(read(f));
        if (!m) { bad.push(`${relative(SDLC, f)} — no frontmatter`); continue; }
        const missing = need(f).filter((k) => !new RegExp(`^${k}:`, 'm').test(m[1]));
        if (missing.length) bad.push(`${relative(SDLC, f)} — ${missing.join(', ')}`);
    }
    assert.ok(walk(SDLC).length > 200, 'the walk found almost nothing');
    assert.deepEqual(bad.sort(), [], 'documents that cannot say where they came from or when they belong');
});

test('X4: a story traces up to a use case and to a requirement', () => {
    const dir = join(SDLC, '06.analysis', '02.user-stories');
    const bad = [];
    for (const f of walk(dir)) {
        if (f.endsWith('README.md')) continue;
        const text = read(f);
        const missing = [];
        if (!/UC-\d+/.test(text)) missing.push('UC');
        if (!/REQ-[A-Z]+-\d+/.test(text)) missing.push('REQ');
        if (missing.length) bad.push(`${relative(SDLC, f)} — no ${missing.join(' · no ')}`);
    }
    assert.deepEqual(bad.sort(), [], 'stories traced to nothing — invented requirements, or orphans');
});

test('X5: an agent spec stays inside the budget it will be read under', () => {
    const specs = walk(join(SDLC, '01.agent-manifests')).filter((f) => f.endsWith('.spec.md'));
    assert.ok(specs.length > 0, 'no agent spec exists — X5 would pass vacuously');
    const over = [];
    for (const f of specs) {
        const text = read(f);
        const lines = text.split('\n').length;
        if (lines > 150 || text.length > 4000) over.push(`${relative(SDLC, f)} — ${lines} dòng · ${text.length} ký tự`);
    }
    assert.deepEqual(over, [], 'specs over 150 lines or 4 000 chars — an agent will skip them');
});

test('X11: every use case is served by a story and rules a business document', () => {
    const catalogue = read(join(SDLC, '06.analysis', '01.business-analysis', '02.use-cases.md'));
    const ucs = [...new Set([...catalogue.matchAll(/UC-\d+/g)].map((m) => m[0]))].sort();
    assert.ok(ucs.length > 0, 'the use-case catalogue declares nothing');

    const stories = walk(join(SDLC, '06.analysis', '02.user-stories')).map(read).join('\n');
    const brd = walk(join(SDLC, '05.requirements', '01.specification', '02.brd')).map(read).join('\n');
    const bad = [];
    for (const uc of ucs) {
        if (!stories.includes(uc)) bad.push(`${uc} — no story serves it`);
        if (!brd.includes(uc)) bad.push(`${uc} — no business document names it`);
    }
    assert.deepEqual(bad.sort(), [], 'use cases nobody serves, or that no business rule mentions');
});

test('X13: every story meets at least two boundaries of the catalogue', () => {
    // Counted through the criteria: a story cites its boundaries in its AC rows, not in its own text. And counted against
    // **every** story — a story with no boundary criteria at all is the case this check exists for, so it must be in the
    // denominator, not silently absent from it.
    const AC = join(SDLC, '06.analysis', '03.acceptance-criteria');
    const edges = new Map();
    for (const f of walk(AC)) {
        for (const line of read(f).split('\n')) {
            const m = /^\| `(AC-[A-Z0-9]+-\d+)-\d+`/.exec(line);
            if (!m) continue;
            const story = `US-${m[1].slice(3)}`;
            for (const e of line.matchAll(/\*\*(ED\d+)\*\*/g)) {
                if (!edges.has(story)) edges.set(story, new Set());
                edges.get(story).add(e[1]);
            }
        }
    }
    const stories = walk(join(SDLC, '06.analysis', '02.user-stories'))
        .filter((f) => !f.endsWith('README.md'))
        .map((f) => (/^id:\s*(US-\S+)/m.exec(read(f)) ?? [])[1])
        .filter(Boolean);
    assert.ok(stories.length > 40, `found only ${stories.length} stories`);

    const thin = stories.filter((s) => (edges.get(s)?.size ?? 0) < 2)
        .map((s) => `${s} — ${edges.get(s)?.size ?? 0} edge(s)`).sort();
    assert.deepEqual(thin, [], 'stories whose only boundary is the happy path');
});
