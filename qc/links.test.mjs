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
const SKIP_PATHS = ['comments/'];

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

test('X1: every link resolves to a file that exists', () => {
    const files = walk(ROOT);
    assert.ok(files.length > 300, `walked only ${files.length} documents — the scan is not covering the repo`);

    const broken = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');   // links in code samples are not links
        const base = dirname(file);
        for (const m of text.matchAll(LINK)) {
            const url = m[1];
            if (IGNORED.test(url) || url.includes(SENTINEL)) continue;
            const target = resolve(base, decodeURI(url.split('#')[0]));
            if (!existsSync(target)) broken.push(`${relative(ROOT, file)} → ${url}`);
        }
    }
    assert.deepEqual(broken.sort(), [], 'references to files that do not exist');
});
