import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// X37 — every feature row owns at least one story.
//
// The defect this prevents: `F-19`…`F-23` were written as features and carried `⏳ 0 AC — v2 chưa có US`
// for months. A catalogue row with no story is a promise with nobody to keep it: the feature reads as
// planned, the epic can be scheduled, and there is no work underneath. `X36` walks the other direction
// (story → feature) and cannot see it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdlc');
const FEATURES = path.join(ROOT, '06.analysis', '01.business-analysis', '06.eso-features.md');
const read = (p) => fs.readFileSync(p, 'utf8');

/** The US a feature row cites: explicit ids plus the one range form its grammar allows. */
const storiesOf = (cell) => {
    const out = new Set(cell.match(/US-[A-Z]+-\d+/g) ?? []);
    const rng = /(US-[A-Z]+-)(\d+)…(\d+)/.exec(cell);
    if (rng) for (let n = Number(rng[2]); n <= Number(rng[3]); n++) out.add(`${rng[1]}${String(n).padStart(2, '0')}`);
    return out;
};

const emptyFeatures = (file) => {
    const bad = [];
    for (const line of read(file).split('\n')) {
        const m = /^\| \*\*(F-\d{2})\*\*/.exec(line);
        if (!m) continue;
        const cells = line.split('|');
        const stories = storiesOf(cells[6] ?? '');
        if (stories.size === 0) bad.push(m[1]);
    }
    return bad.sort();
};

test('X37: every feature row owns at least one story', () => {
    const bad = emptyFeatures(FEATURES);
    assert.deepEqual(bad, [], 'features with no story — a row nobody can build');
});

test('X37 can fail — a feature row with no story is reported', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'eso-x37-'));
    const file = path.join(dir, 'features.md');
    fs.writeFileSync(file, [
        '| **F-01** | a | b | c | d | `US-A-01` | 1 AC |',
        '| **F-02** | a | b | c | d | — | ⏳ 0 AC |',
        '| **F-03** | a | b | c | d | `US-A-02…03` | 2 AC |',
    ].join('\n'));
    assert.deepEqual(emptyFeatures(file), ['F-02']);
});
