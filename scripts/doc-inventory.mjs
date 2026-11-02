#!/usr/bin/env node
/**
 * F-19 — inventory of the knowledge a project runs on.
 *
 * This is the smallest thing that can be *wrong*. It reads a template (what this project says it must have), walks the tree
 * (what it actually has), and names the difference by **kind** — never as "some documents are missing".
 *
 * It refuses when there is no template. That is not a limitation, it is the rule: with no ruler, every set is "enough", and a
 * report that cannot refuse is a report that always says yes.
 *
 * Usage: node scripts/doc-inventory.mjs [--template sdlc/02.governance/01.standard/templates/library.json]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SDLC = join(ROOT, 'sdlc');
const CATALOGUE = join(SDLC, '02.governance', '01.standard', '02.artifacts.md');
const argOf = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const TEMPLATE = join(ROOT, argOf('--template', 'sdlc/02.governance/01.standard/templates/library.json'));

const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith('.md')) out.push(full);
    }
    return out;
};

/** `| `kind` | OWNER |` — the same two-cell shape X27 reads out of the standard. */
const owners = () => {
    const map = new Map();
    for (const line of readFileSync(CATALOGUE, 'utf8').split('\n')) {
        const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([A-Za-z/]+)\s*\|$/.exec(line);
        if (m) map.set(m[1], m[2]);
    }
    return map;
};

const main = () => {
    // Refusal 1 of F-19: no template, no measurement.
    if (!existsSync(TEMPLATE)) {
        console.log(`refused: TEMPLATE_ABSENT — ${relative(ROOT, TEMPLATE)} does not exist`);
        console.log('a report without a ruler says "enough" about anything; define the template first');
        process.exitCode = 1;
        return;
    }
    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const required = new Set(template.required ?? []);
    const known = owners();

    const counts = new Map();
    const unowned = new Map();
    for (const file of walk(SDLC)) {
        const m = /^type:\s*"?([a-z0-9-]+)"?$/m.exec(readFileSync(file, 'utf8'));
        if (!m) continue;
        const kind = m[1];
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (!known.has(kind)) unowned.set(kind, (unowned.get(kind) ?? 0) + 1);
    }

    const rows = [...counts.keys()].sort().map((kind) => ({
        kind,
        count: counts.get(kind),
        owner: known.get(kind) ?? '—',
        required: required.has(kind),
    }));

    console.log(`template   ${template.id} v${template.version}`);
    console.log(`kinds      ${rows.length} present · ${required.size} required by the template`);
    console.log('');

    const missing = [...required].filter((k) => !counts.has(k)).sort();
    const unownedRows = [...unowned].map(([k, n]) => `${k} (${n})`).sort();
    const findings = [
        ...missing.map((k) => `MISSING_KIND   ${k} — required by the template, no instance in the tree`),
        ...unownedRows.map((k) => `KIND_UNOWNED   ${k} — present, nobody signs it`),
    ];
    const clean = findings.length === 0;

    // Kinds the catalogue names but this project has none of. Not a fault under `library` — and exactly what an `enterprise`
    // template would refuse. Printing them keeps "not required" distinguishable from "not noticed".
    const absent = [...known.keys()].filter((k) => !counts.has(k)).sort();
    console.log(`absent     ${absent.length ? absent.join(' · ') : '(none)'}`);
    console.log('');
    console.log(`status ${clean ? 'clean' : 'measured'}`);
    for (const f of findings) console.log(`  ${f}`);
    if (!clean) console.log('');

    // F-19 §3: a report must say what it cannot see. Nothing in this tree declares a provider-held artifact.
    console.log('unseen     providers hold plans, memory and scratch that no template covers;');
    console.log('           this inventory counted only what is written in sdlc/.');
    process.exitCode = clean ? 0 : 2;
};

main();
