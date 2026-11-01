// X7 — document shape conformance for the sdlc/ tree.
//
// The rule lives in sdlc/02.governance/01.standard/02.artifacts.md §2: every document kind has required sections.
// The check was manual twice (see sdlc/02.governance/07.x7-analysis.md); this test makes it a gate.
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
    const standard = read(join(SDLC, '02.governance', '01.standard', '02.artifacts.md'));
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
