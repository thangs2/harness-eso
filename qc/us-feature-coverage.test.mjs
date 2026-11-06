import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// X36 — every story belongs to a feature row, or says out loud that it does not.
//
// The defect this prevents: 34 stories existed with files and ACs while no feature row named them, so the
// matrix read as a complete inventory and was not one. `X35` cannot catch it — it only counts the ACs of
// the stories a row *does* list, so an unlisted story is invisible to it. That is the shape that made
// `US-UI-01/03/04` disappear while `US-UI-02/05` stayed.
const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdlc');
const read = (p) => fs.readFileSync(p, 'utf8');

const layout = (root) => ({
    stories: path.join(root, '06.analysis', '02.user-stories'),
    features: path.join(root, '06.analysis', '01.business-analysis', '06.eso-features.md'),
    register: path.join(root, '06.analysis', '05.orphan-stories.md'),
});

const storyIds = (root) => {
    const ids = new Set();
    const dir = layout(root).stories;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md') || name === 'README.md') continue;
        const m = /^us:\s*(US-\S+)/m.exec(read(path.join(dir, name)));
        if (m) ids.add(m[1]);
    }
    return ids;
};

/** Feature rows cite stories in two shapes: explicit ids, and ranges like `US-GRAPH-01…04`.
 *  Missing the range form is how X36 first "found" 34 orphans when only 25 were unowned. */
const citedByFeature = (root) => {
    const out = new Set();
    for (const line of read(layout(root).features).split('\n')) {
        if (!/^\| \*\*F-\d{2}\*\*/.test(line)) continue;
        const cells = line.split('|');
        const cell = cells[6] ?? '';
        for (const m of cell.matchAll(/US-[A-Z]+-\d+/g)) out.add(m[0]);
        for (const m of cell.matchAll(/(US-[A-Z]+-)(\d+)…(\d+)/g)) {
            for (let n = Number(m[2]); n <= Number(m[3]); n++) out.add(`${m[1]}${String(n).padStart(2, '0')}`);
        }
    }
    return out;
};

/** Rows of the debt register: | `US-X-01` | owner | why | certainty | */
const registered = (root) => {
    const out = new Map();
    const file = layout(root).register;
    if (!fs.existsSync(file)) return out;
    for (const line of read(file).split('\n')) {
        const m = /^\|\s*`(US-[A-Z0-9]+-\d+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
        if (m) out.set(m[1], { owner: m[2].trim(), why: m[3].trim(), sure: m[4].trim() });
    }
    return out;
};

/** The three questions X36 asks, as a pure function so the negative controls can drive it. */
const findings = (root) => {
    const stories = storyIds(root);
    const cited = citedByFeature(root);
    const reg = registered(root);
    return {
        stories: stories.size,
        cited: cited.size,
        homeless: [...stories].filter((s) => !cited.has(s) && !reg.has(s)).sort(),
        stale: [...reg.keys()].filter((s) => cited.has(s)).sort(),
        unnamed: [...reg.entries()]
            .filter(([id, r]) => !stories.has(id) || !r.owner || !r.why || !r.sure)
            .map(([id]) => id)
            .sort(),
    };
};

const write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
};

/** A tiny tree: one cited story, one registered story, one feature row. */
const fixture = ({ extraStory = null, registerExtra = '', citeRegistered = false } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-x36-'));
    const L = layout(root);
    write(path.join(L.stories, '01.a.md'), '---\nus: US-A-01\n---\n# a\n');
    write(path.join(L.stories, '02.b.md'), '---\nus: US-B-01\n---\n# b\n');
    if (extraStory) write(path.join(L.stories, '03.c.md'), `---\nus: ${extraStory}\n---\n# c\n`);
    write(L.features, `| **F-01** | a | b | c | d | \`US-A-01\` | 1 AC |\n| **F-02** | a | b | c | d | ${citeRegistered ? '\`US-B-01\`' : '—'} | 1 AC |\n`);
    write(L.register, `| US | Chủ đúng | Vì sao | Chắc |\n|---|---|---|---|\n| \`US-B-01\` | \`F-01\` | thiếu | chắc |\n${registerExtra}`);
    return root;
};

test('X36: every story is received by a feature, or registered with an owner', () => {
    const f = findings(REAL);
    assert.ok(f.stories > 40, `found only ${f.stories} stories — the scan is not covering the folder`);
    assert.ok(f.cited > 20, `found only ${f.cited} cited stories — the feature table moved`);
    assert.deepEqual(f.homeless, [], 'stories no feature owns and no register row explains');
});

test('X36: the register only shrinks — a registered story that is now cited must be deleted from it', () => {
    assert.deepEqual(findings(REAL).stale, [], 'register rows whose story is now owned by a feature — delete them');
});

test('X36: a register row names the owner and the reason, and points at a story that exists', () => {
    assert.deepEqual(findings(REAL).unnamed, [], 'register rows that cannot say who owns the story or why');
});

// Negative controls: the three questions must be able to answer "yes, something is wrong".
test('X36 can fail — a story with no feature and no register row is reported', () => {
    const root = fixture({ extraStory: 'US-C-01' });
    assert.deepEqual(findings(root).homeless, ['US-C-01']);
});

test('X36 can fail — a register row whose story became cited is reported as stale', () => {
    const root = fixture({ citeRegistered: true });
    assert.deepEqual(findings(root).stale, ['US-B-01']);
});

test('X36 can fail — a register row with no owner is reported', () => {
    const root = fixture({ registerExtra: '| `US-B-02` |  | thiếu | chắc |\n' });
    assert.ok(findings(root).unnamed.includes('US-B-02'));
});
