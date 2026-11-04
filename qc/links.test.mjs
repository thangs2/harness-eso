// X1 — every link resolves.
//
// The first row of the cross-check register, and the only one that was never implemented. It stayed invisible because the
// links kept working often enough: a rename here, a moved folder there, and the reference that broke was never in the file
// anybody opened next. This week it cost two rounds on the `standard/` move and left `AGENTS.md` — a file loaded into every
// session by a forced rule — pointing at `docs/02.cursor-windows.md`, a path that had not existed for weeks.
//
// Scope is deliberate and wider than the rest of the suite: `.md` **and** `.mdc`, hidden directories included. The twenty-one
// dead references that survived did so because the earlier scan used `glob`, which does not descend into dot-directories,
// and looked only at markdown. A check whose scope is narrower than the error's is a check that reports success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.git', '.docgraph', '.codegraph', 'dist', 'build']);
// `comments/` holds dated records of past work. A record must keep saying what it said, so its links are not rewritten and
// therefore not checked. That is a rule, not an exception list.
// Dated records are not rewritten, so their references are not checked either: `comments/` and the archive.
const SKIP_PATHS = ['comments/', 'docs/08.archive/'];

const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        const rel = relative(ROOT, full);
        if (SKIP_PATHS.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p))) continue;
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (name.endsWith('.md') || name.endsWith('.mdc')) out.push(full);
    }
    return out;
};

const LINK = /\]\(([^)\s]+)\)/g;
const IGNORED = /^(https?:|mailto:|tel:|#|file:)/;
// A placeholder used in prose to show what a *missing* reference looks like. It is documented as nonexistent.
const SENTINEL = 'khong-co';

/**
 * Every markdown target in one document, judged against `base`.
 *
 * Fenced blocks are code samples, not links. Inline code is the opposite: ESO-379 — stripping it here hid three real
 * references under `sdlc/`, and a scan whose scope is narrower than the error reports success. `comments/` and the
 * archive stay out of scope through `SKIP_PATHS`, so a dated record keeps saying what it said.
 */
function scanTargets(text, base) {
    const prose = text.replace(/```[\s\S]*?```/g, '');
    const out = [];
    for (const m of prose.matchAll(LINK)) {
        const url = m[1];
        if (IGNORED.test(url) || url.includes(SENTINEL)) continue;
        const lineStart = prose.lastIndexOf('\n', m.index) + 1;
        const inline = (prose.slice(lineStart, m.index).match(/`/g) || []).length % 2 === 1;
        out.push({ url, inline, exists: existsSync(resolve(base, decodeURI(url.split('#')[0]))) });
    }
    return out;
}

test('X1: every link resolves to a file that exists', () => {
    const files = walk(ROOT);
    assert.ok(files.length > 300, `walked only ${files.length} documents — the scan is not covering the repo`);

    const documents = files.map((file) => ({
        label: relative(ROOT, file),
        text: readFileSync(file, 'utf8'),
        base: dirname(file),
    }));
    // Audit fixture (ESO-379): `LINK_SCAN_BROKEN=1` appends one known-broken inline reference. The same check must then
    // exit non-zero, which is how "this scan can fail" is measured instead of asserted. The default run is untouched.
    if (process.env.LINK_SCAN_BROKEN === '1') {
        documents.push({
            label: '<negative-case>',
            text: 'Xem `[hỏng](./task4-negative-case-missing.md)` để thấy.',
            base: ROOT,
        });
    }

    const broken = [];
    let seen = 0;
    let inline = 0;
    for (const doc of documents) {
        for (const hit of scanTargets(doc.text, doc.base)) {
            seen++;
            if (hit.inline) inline++;
            if (!hit.exists) broken.push(`${doc.label} → ${hit.url}`);
        }
    }
    assert.ok(seen > 1000, `scanned only ${seen} links — the scan is not covering the repo`);
    assert.ok(inline > 0, 'no link inside inline code was scanned — the ESO-379 scope was lost again');
    assert.deepEqual(broken.sort(), [], 'references to files that do not exist');
});

test('X1: the scan can fail — a broken link in inline code is reported (negative control)', () => {
    /*
     * ESO-379. The scanner this file replaced stripped inline code along with fenced blocks, so a reference written as
     * prose inside backticks could never break the check. This control runs both scanners on one fixture and asserts
     * they disagree: the current one reports the broken inline link, the weakened one reports nothing. Without the
     * second assertion the first would be a constant — true whether or not the scope was restored.
     */
    const fixture = 'Xem `[hỏng](./task4-nonexistent-inline.md)` và\n\n```md\n[fenced](./task4-nonexistent-fenced.md)\n```\n';
    assert.deepEqual(
        scanTargets(fixture, ROOT).map((hit) => [hit.url, hit.inline, hit.exists]),
        [['./task4-nonexistent-inline.md', true, false]],
        'inline code must be prose; fenced code must not be read as a link',
    );

    const weakened = fixture.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    assert.deepEqual(scanTargets(weakened, ROOT), [], 'the weakened input must hide the link, or this control proves nothing');
});

// X28 — every repository path written in prose or in code points at something that exists.
//
// X1 only sees markdown syntax. But this repo names file paths in places markdown never reaches: `declaredIn` values in the
// ownership table, `docs/...` references in `.mdc` rules, docker comments, shell scripts, `docgraph.json` scope. Those are
// exactly the places a folder rename breaks silently — the code still runs, the reference still reads fine, and the only way to
// find out is to open the file and notice it is not there.
//
// This is the check that would have caught `docs/02.cursor-windows.md` in `AGENTS.md` before a human did.
test('X28: every docs/ path named anywhere resolves', () => {
    const TEXT = /\.(md|mdc|mjs|json|yml|yaml|sh|toml|Dockerfile)$/;
    const PATH_TOKEN = /\b(?:docs|documents)\/[A-Za-z0-9._/-]+\.(?:md|mdc|json|yml|yaml|png|svg)/g;
    const files = [];
    const collect = (dir) => {
        for (const name of readdirSync(dir)) {
            if (SKIP_DIRS.has(name)) continue;
            const full = join(dir, name);
            const rel = relative(ROOT, full);
            if (SKIP_PATHS.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p))) continue;
            if (statSync(full).isDirectory()) collect(full);
            else if (TEXT.test(name) && !name.endsWith('.test.mjs')) files.push(full);   // test fixtures build fake trees
        }
    };
    collect(ROOT);
    assert.ok(files.length > 100, `walked only ${files.length} files — the scan is not covering the repo`);

    const missing = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
            // A path the line declares as an *output* is allowed not to exist yet — but it must say so where it is read.
            if (line.includes('x28-allow')) continue;
            for (const m of line.matchAll(PATH_TOKEN)) {
                // `<consumer>/docs/...` belongs to a provisioned project, not to this repo. Two repos with a folder of the
                // same name is exactly how `docs/` came to mean two different things; naming the owner is the fix.
                const before = line.slice(0, m.index);
                if (before.endsWith('<consumer>/') || /[a-z-]+:\s*$/.test(before)) continue;
                if (!existsSync(join(ROOT, m[0]))) missing.push(`${relative(ROOT, file)} → ${m[0]}`);
            }
        }
    }
    assert.deepEqual([...new Set(missing)].sort(), [], 'paths named in text or code that do not exist');
});
