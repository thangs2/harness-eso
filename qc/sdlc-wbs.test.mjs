// The work breakdown's exit gate is a packet per slice. That is still missing, but one thing can be
// checked now: every criterion is claimed by exactly one task, and every task entry has the fields
// that make work assignable. A task that cites no criterion is an intention; a criterion no task
// cites is behaviour nobody owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const AC_DIR = join(ROOT, 'sdlc/06.analysis/03.acceptance-criteria');
const WBS_DIR = join(ROOT, 'sdlc/09.wbs');
const FIELDS = ['Việc', 'Input', 'Output', 'Phụ thuộc', 'Ước lượng', 'DoD', 'Owner'];

function dictionaries() {
    return readdirSync(WBS_DIR)
        .filter((n) => /^0\d\.dictionary.*\.md$/.test(n))
        .map((n) => readFileSync(join(WBS_DIR, n), 'utf8'));
}

function tasks(text) {
    const out = new Map();
    const parts = text.split(/\n### /).slice(1);
    for (const part of parts) {
        const id = /^(W\d-\d+)/.exec(part);
        if (!id) continue;
        // The block ends at the next heading of the same or higher level. The coverage table that
        // follows the tasks also contains criterion ids; counting those would double-count every
        // criterion once per table row.
        const block = part.split(/\n## /)[0];
        const acs = [...new Set(block.match(/AC-[A-Z]+-\d+-\d\d/g) ?? [])];
        out.set(id[1], { acs, out: /\bOUT\b/.test(block) });
    }
    return out;
}

function allCriteria() {
    const ids = new Set();
    for (const name of readdirSync(AC_DIR)) {
        if (!name.endsWith('.md') || name === 'README.md') continue;
        const text = readFileSync(join(AC_DIR, name), 'utf8');
        for (const m of text.matchAll(/^\| `(AC-[A-Z]+-\d+-\d\d)` \|/gm)) ids.add(m[1]);
    }
    return ids;
}

test('WBS: every dictionary task carries the seven fields', () => {
    const bad = [];
    for (const text of dictionaries()) {
        for (const part of text.split(/\n### /).slice(1)) {
            const id = /^(W\d-\d+)/.exec(part);
            if (!id) continue;
            const missing = FIELDS.filter((f) => !part.includes(`| **${f}** |`));
            if (missing.length) bad.push(`${id[1]} → ${missing.join(', ')}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('WBS: no criterion is claimed by two tasks', () => {
    const claimed = new Map();
    const twice = [];
    for (const text of dictionaries()) {
        for (const [id, { acs }] of tasks(text)) {
            for (const ac of acs) {
                if (claimed.has(ac)) twice.push(`${ac} → ${claimed.get(ac)} and ${id}`);
                else claimed.set(ac, id);
            }
        }
    }
    assert.deepEqual(twice, []);
});

test('WBS: every task cites at least one criterion', () => {
    const bare = [];
    for (const text of dictionaries()) {
        for (const [id, { acs, out }] of tasks(text)) {
            // A task may own no criterion only if it says so out loud ("OUT" with a reason) —
            // the environment tasks build the ability to work and have no product behaviour.
            if (acs.length === 0 && !out) bare.push(id);
        }
    }
    assert.deepEqual(bare, [], 'tasks that cite no criterion are intentions, not tasks');
});

// The map assigns each story to a wave; the dictionaries cover the waves written so far. This test
// holds the two together so a wave cannot be declared done while its criteria are unclaimed.
test('WBS: criteria of a covered wave are all claimed by a task', () => {
    const claimed = new Set();
    for (const text of dictionaries()) {
        for (const [, { acs }] of tasks(text)) for (const ac of acs) claimed.add(ac);
    }
    const all = allCriteria();
    const uncovered = [...all].filter((a) => !claimed.has(a));
    // Waves W2 and W3 are the ones written up; their criteria must be fully claimed.
    // Waves W1, W2 and W3 are written up; every criterion they own must have an owning task.
    // ARCH-05/06 belong to W5 (tenancy, permissions) and are not written up yet, so they are out
    // of scope here rather than silently passing.
    // W1, W2, W3, W4 and W6 are written up. ARCH-05/06 (W5), KB only in W4, and nothing from W7
    // are in scope yet.
    const inScope = uncovered.filter(
        (a) =>
            /^AC-(EV|AGENT|SUF|KB|LEARN|UI|HOST-05)-/.test(a) || /^AC-ARCH-0[1-4]-/.test(a),
    );
    assert.deepEqual(inScope, [], 'criteria in a written-up wave with no owning task');
    assert.ok(claimed.size > 50, `expected a substantial claim set, saw ${claimed.size}`);
});
