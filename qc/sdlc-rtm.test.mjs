// The IAM trace matrix must stay derived. It was hand-written once, and when the item grew from
// twenty-three criteria to fifty it silently kept twenty-three rows while its own title still
// claimed twenty-three. A table that states its row count is a table that will be wrong; this test
// makes the file a projection of the criteria and the scenario matrix instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const AC_DIR = join(ROOT, 'sdlc/06.analysis/03.acceptance-criteria');
const MATRIX = join(ROOT, 'sdlc/06.analysis/04.quality-control/02.iam-scenario-matrix.md');
const RTM = join(ROOT, 'sdlc/06.analysis/04.quality-control/03.iam-rtm.md');

function iamCriteria() {
    const out = new Map();
    for (const name of readdirSync(AC_DIR)) {
        if (!name.endsWith('.md') || name === 'README.md') continue;
        const text = readFileSync(join(AC_DIR, name), 'utf8');
        for (const line of text.split('\n')) {
            const m = /^\| `(AC-IAM-\d+-\d\d)` \| \*{0,2}([a-z]+)\*{0,2} \|/.exec(line);
            if (m) out.set(m[1], m[2]);
        }
    }
    return out;
}

function matrixRows() {
    const out = new Map(); // ac -> { scn, test }
    const text = readFileSync(MATRIX, 'utf8');
    for (const line of text.split('\n')) {
        const m = /^\| `(SCN-IAM-[^`]+)` \| (AC-IAM-\d+-\d\d) \|/.exec(line);
        if (!m) continue;
        const cells = line.split('|').map((c) => c.trim());
        const test = (cells[cells.length - 3] || '').replace(/`/g, '');
        out.set(m[2], { scn: m[1], test });
    }
    return out;
}

function rtmRows() {
    const out = new Map();
    for (const line of readFileSync(RTM, 'utf8').split('\n')) {
        const m = /^\| `(AC-IAM-\d+-\d\d)` \|/.exec(line);
        if (m) out.set(m[1], line);
    }
    return out;
}

test('RTM: every IAM criterion appears exactly once', () => {
    const acs = [...iamCriteria().keys()].sort();
    const rows = rtmRows();
    const missing = acs.filter((a) => !rows.has(a));
    const extra = [...rows.keys()].filter((a) => !iamCriteria().has(a));
    assert.deepEqual(missing, [], 'criteria without a trace row');
    assert.deepEqual(extra, [], 'trace rows for criteria that do not exist');
    assert.equal(rows.size, acs.length);
});

test('RTM: the scenario and test named for each criterion match the matrix', () => {
    const matrix = matrixRows();
    const bad = [];
    for (const [ac, line] of rtmRows()) {
        const m = matrix.get(ac);
        if (!m) { bad.push(`${ac} → no scenario`); continue; }
        if (!line.includes(m.scn)) bad.push(`${ac} → SCN ${m.scn} missing from the row`);
        if (m.test && !line.includes(m.test)) bad.push(`${ac} → test ${m.test} missing from the row`);
    }
    assert.deepEqual(bad, []);
});

test('RTM: the type in the row matches the criterion file', () => {
    const types = iamCriteria();
    const bad = [];
    for (const [ac, line] of rtmRows()) {
        const cells = line.split('|').map((c) => c.trim());
        const type = (cells[3] || '').replace(/\*/g, '');
        if (types.get(ac) !== type) bad.push(`${ac} → ${type} vs ${types.get(ac)}`);
    }
    assert.deepEqual(bad, []);
});
