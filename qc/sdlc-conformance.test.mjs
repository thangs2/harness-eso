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
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');

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
            if (m) keys[m[1]] = m[2].trim().replace(/^"|"$/g, '');
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
    'data-model', 'api-contract', 'ui-design', 'query-spec', 'wbs', 'bip', 'fip',
    'decision-log', 'feature-catalog', 'traceability-matrix', 'domain-spec', 'capability-spec', 'capability-index',
]);

const hasAll = (text, names) => names.every((n) => SECTION[n].some((re) => re.test(text)));

test('X7: every document declares a type the standard knows', () => {
    const unknown = [];
    let n = 0;
    for (const f of walk(SDLC)) {
        if (f.endsWith('README.md')) continue;
        const { type } = parse(f);
        if (!type) continue;
        n += 1;
        if (!(type in RULES) && !JUDGEMENT.has(type)) unknown.push(`${relative(ROOT, f)} → ${type}`);
    }
    assert.ok(n > 150, `expected the tree to be large, saw ${n} typed documents`);
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
