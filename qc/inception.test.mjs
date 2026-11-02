// Checks for the inception folder (problem · vision · decision-log · artifact-model).
//
// These exist because 35 defects were found there by reading, and **none** of them was caught by a machine: a stated count that did
// not match the body, an id cited with no row defining it, a register missing the item it registers. The generic checks scan every
// document for shape; these two ask about the two things shape cannot see — arithmetic and registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');
const INC = join(SDLC, '03.inception');
const read = (p) => readFileSync(p, 'utf8');

const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith('.md')) out.push(full);
    }
    return out;
};

// ── X31 ─────────────────────────────────────────────────────────────────────
// Every id a document cites must have a row that defines it. The defect this prevents is "real but unregistered": `P7` had a section
// and no row in the register, `D-56` was cited by the standard and never written, `G-J` had a goal and no metric.
test('X31: every id cited in sdlc/ is defined where its family is owned', () => {
    const defs = (files, re) => {
        const s = new Set();
        for (const f of files) for (const m of read(f).matchAll(re)) s.add(m[1]);
        return s;
    };
    const inDir = (dir) => walk(join(SDLC, dir));
    const FAMILIES = [
        // [1-9] and a negative lookahead: `P0.3` is a clause in an external quality-gate standard, not a pain point.
        { name: 'P', ref: /\bP([1-9])\b(?!\.)/g, def: defs([join(INC, '00.problem', '00.index.md')], /^\| \*\*P(\d+)\*\* \|/gm) },
        { name: 'G', ref: /\bG-([A-Z])\b/g, def: defs([join(INC, '01.vision', '01.vision-mission-goals.md')], /^### G-([A-Z]) /gm) },
        { name: 'O', ref: /\bO-(\d)\b/g, def: defs([join(INC, '01.vision', '01.vision-mission-goals.md')], /^### O-(\d) /gm) },
        { name: 'D', ref: /\bD-(\d{2})\b/g, def: defs(inDir('03.inception/02.decision-log'), /^### D-(\d{2}) — /gm) },
        { name: 'DQ', ref: /\bDQ-(\d{2})\b/g, def: defs([join(INC, '02.decision-log', '01.open-decisions.md')], /^### `DQ-(\d{2})`/gm) },
        { name: 'MET', ref: /\bMET-(\d+)\b/g, def: defs([join(SDLC, '05.requirements', '01.specification', '01.prd', '06.success-metrics.md')], /^\|\s*`MET-(\d+)`\s*\|/gm) },
        { name: 'F', ref: /\bF-(\d{2})\b/g, def: defs([join(SDLC, '06.analysis', '01.business-analysis', '06.eso-features.md')], /\*\*F-(\d{2})\*\*/g) },
    ];

    const corpus = walk(SDLC).map((f) => [relative(SDLC, f), read(f)]);
    const problems = [];
    for (const fam of FAMILIES) {
        // A family with no definitions would make this check pass for the wrong reason — every citation would be "defined" by nothing.
        assert.ok(fam.def.size > 0, `${fam.name}: no definitions found — the check would be vacuous`);
        for (const [file, text] of corpus) {
            for (const m of text.matchAll(fam.ref)) {
                if (!fam.def.has(m[1])) problems.push(`${file}: cites ${fam.name}-${m[1]}, which nothing defines`);
            }
        }
    }
    assert.deepEqual([...new Set(problems)].sort(), [], 'ids cited but never defined');

    // Catalogue ↔ runner. The register claimed "eighteen have a test" for weeks because nothing compared the two lists: `X3b`, `X9b`
    // and `X8a` were implemented under names the catalogue did not contain, and the catalogue listed ids no test answered to.
    const cat = new Set([...read(join(SDLC, '02.governance', '01.standard', '06.checks.md')).matchAll(/^\| \*\*(X\d+[a-z]?)\*\*/gm)].map((m) => m[1]));
    const run = new Set();
    for (const f of readdirSync(join(ROOT, 'qc')).filter((n) => n.endsWith('.test.mjs'))) for (const m of read(join(ROOT, 'qc', f)).matchAll(/test\('(X\d+[a-z]?):/g)) run.add(m[1]);
    assert.ok(cat.size > 20 && run.size > 20, `catalogue ${cat.size} / runner ${run.size} — one side stopped parsing`);
    assert.deepEqual([...cat].filter((c) => !run.has(c)).sort(), [], 'checks named in the catalogue with no test behind them');
    assert.deepEqual([...run].filter((r) => !cat.has(r)).sort(), [], 'tests whose id the catalogue does not name');
});

// ── X30 ─────────────────────────────────────────────────────────────────────
// A number a document states about itself must match the document. "Sáu mục" over ten goals is not a typo; it is the reader being
// told to look for six things and finding ten.
test('X30: a count stated in prose equals the thing it counts', () => {
    const vision = read(join(INC, '01.vision', '01.vision-mission-goals.md'));
    const goals = [...vision.matchAll(/^### (G-[A-Z]) /gm)].map((m) => m[1]).length;
    const objectives = [...vision.matchAll(/^### (O-\d) /gm)].map((m) => m[1]).length;

    // Vietnamese numerals are written as words, sometimes in two ("Mười lăm"). A hardcoded map of single words cannot read them, and
    // `\w` cannot match them at all — JavaScript's regex word class is ASCII-only.
    const NUM = (raw) => {
        const UNITS = { một: 1, hai: 2, ba: 3, bốn: 4, năm: 5, lăm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9 };
        const parts = raw.trim().toLowerCase().split(/\s+/);
        if (parts.length === 1) return parts[0] === 'mười' ? 10 : UNITS[parts[0]];
        if (parts[0] === 'mười' && parts.length === 2) return 10 + (UNITS[parts[1]] ?? NaN);
        return undefined;
    };
    const stated = [];
    const ascii = /Goals\s+(\d+) mục/.exec(vision);
    assert.ok(ascii, 'the vision map no longer states a goal count — update this check deliberately');
    stated.push(['ascii map goal count', Number(ascii[1]), goals]);
    // \S+, not \w+: JavaScript\'s \w is ASCII-only and would never match "Mười".
    const prose = /^([^\n]+?) mục\. Mỗi mục có phép thử/m.exec(vision);
    assert.ok(prose, 'the goals section no longer opens with a count — update this check deliberately');
    assert.ok(NUM(prose[1]) !== undefined, `unmapped numeral "${prose[1]}" in the goals opening`);
    stated.push(['goals opening count', NUM(prose[1]), goals]);

    // Sections of the status register that number themselves in the heading.
    const status = read(join(INC, '03.artifact-model', '05.status.md'));
    for (const m of status.matchAll(/^## \d\. [^(\n]+\((\d+)\)$/gm)) {
        const start = status.indexOf(m[0]);
        const rest = status.slice(start + m[0].length);
        const body = rest.split(/^## /m)[0];
        const rows = [...body.matchAll(/^\| (?:[a-z]|\d+) \|/gm)].length;
        stated.push([`status heading "${m[0].slice(3, 30)}"`, Number(m[1]), rows]);
    }

    // The decision log counts itself too: §1's heading states how many DQ exist, §2's states how many need the operator. Both were
    // written when there were fourteen, and adding `DQ-15` left both wrong until this check existed.
    const open = read(join(INC, '02.decision-log', '01.open-decisions.md'));
    const dq = [...open.matchAll(/^### `DQ-\d{2}`/gm)].length;
    const dqHeading = /^## 1\. ([^\n]+?) quyết định$/m.exec(open);
    assert.ok(dqHeading && NUM(dqHeading[1]) !== undefined, 'the DQ section no longer opens with a numeral');
    stated.push(['§1 DQ heading', NUM(dqHeading[1]), dq]);
    const needYou = /^## 2\. [^\n]*\*\*([^*]+)\*\* cái/m.exec(open);
    assert.ok(needYou && NUM(needYou[1]) !== undefined, 'the "needs you" heading no longer states a numeral');
    const ticked = [...open.matchAll(/^\| ✅ \| \*\*`DQ-\d{2}`\*\*/gm)].length;
    stated.push(['§2 needs-you heading', NUM(needYou[1]), ticked]);

    // "N phép kiểm" anywhere in sdlc/ must equal the catalogue's row count. Eleven documents carried "29" while the catalogue held 33;
    // the number was copied by hand into prose and nothing compared it to the thing it counted.
    const catalogueRows = [...read(join(SDLC, '02.governance', '01.standard', '06.checks.md'))
        .matchAll(/^\| \*\*(X\d+[a-z]?)\*\*/gm)].length;
    for (const [file, text] of walk(SDLC).map((f) => [relative(SDLC, f), read(f)])) {
        for (const m of text.matchAll(/(\d+) phép kiểm/g)) {
            stated.push([`${file}: "${m[0]}"`, Number(m[1]), catalogueRows]);
        }
    }

    assert.ok(objectives >= 1 && stated.length >= 3, 'nothing was checked — the patterns have drifted');
    const wrong = stated.filter(([, declared, actual]) => declared !== actual)
        .map(([what, declared, actual]) => `${what}: says ${declared}, body has ${actual}`);
    assert.deepEqual(wrong, [], 'stated counts that contradict the document');
});
