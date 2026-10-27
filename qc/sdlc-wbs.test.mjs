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
        // One file per wave: NN.dictionary-wN.md. Match the kind, not a fixed prefix, so renumbering
        // the folder does not silently empty this test.
        .filter((n) => /^\d+\.dictionary-w\d+\.md$/.test(n))
        .map((n) => readFileSync(join(WBS_DIR, n), 'utf8'));
}

function tasks(text) {
    const out = new Map();
    const parts = text.split(/\n### /).slice(1);
    for (const part of parts) {
        // Work packages carry a WBS code of account (2.3); older text used W2-3. Accept both so the
        // check survives a renumbering, and keep the code as the identity.
        const id = /^`(\d+\.\d+)`/.exec(part) ?? /^(W\d-\d+)/.exec(part);
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
    // All eight waves are written up. Any uncovered criterion is now a real gap, not a wave that
    // has not been reached yet.
    const inScope = uncovered;
    assert.deepEqual(inScope, [], 'criteria in a written-up wave with no owning task');
    assert.equal(claimed.size, all.size, 'every criterion must be claimed by a task');
});

// X8: a slice is implementable only if it has a packet, or says why it has none. The first packet
// is a sample, so this test checks the property rather than counting packets: any packet present
// must carry its required sections, and a [be]-only wave must carry an explicit FIP = OUT.
test('X8: packets present carry their required sections', () => {
    const sections = {
        bip: ['1. Slice identity', '2. Sources', '3. Business binding', '4. Contract & transaction',
              '5. Data & persistence', '6. Invariants', '7. Test plan', '8. `OPEN` register', '9. Decision'],
    };
    const bad = [];
    for (const dir of ['09.packets']) {
        const abs = join(WBS_DIR, dir);
        let names = [];
        try { names = readdirSync(abs); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('.md')) continue;
            const text = readFileSync(join(abs, name), 'utf8');
            const kind = /^type:\s*(bip|fip)$/m.exec(text)?.[1];
            if (!kind) continue;
            if (kind === 'bip') {
                const missing = sections.bip.filter((h) => !text.includes(`## ${h}`));
                if (missing.length) bad.push(`${name} → ${missing.join(', ')}`);
            }
            if (kind === 'fip' && !/OUT/.test(text)) bad.push(`${name} → a FIP must say OUT when it has no surface`);
        }
    }
    assert.deepEqual(bad, []);
});

test('X8: a wave with no interface criteria carries FIP = OUT', () => {
    const packets = join(WBS_DIR, '09.packets');
    let names = [];
    try { names = readdirSync(packets); } catch { return; }
    const fips = names.filter((n) => n.startsWith('02.fip')).map((n) => readFileSync(join(packets, n), 'utf8'));
    if (fips.length === 0) return;
    assert.ok(fips.some((t) => /\bOUT\b/.test(t)), 'a back-end-only wave must record FIP = OUT with a reason');
});

// A packet may only be READY when nothing in its open register is still open. A READY packet with
// live questions is how "ready" stops meaning anything.
test('X8: a READY packet has no open items left', () => {
    const packets = join(WBS_DIR, '09.packets');
    let names = [];
    try { names = readdirSync(packets); } catch { return; }
    const bad = [];
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const text = readFileSync(join(packets, name), 'utf8');
        if (!/^type:\s*bip$/m.test(text)) continue;
        const ready = /\| \*\*status\*\* \| `READY` \|/.test(text) || /status \| `READY`/.test(text);
        if (!ready) continue;
        // rows that are not struck through and still look like an open item
        const live = text
            .split('\n')
            .filter((l) => /^\| `OPEN-\d+` \|/.test(l));
        if (live.length) bad.push(`${name} → ${live.length} open item(s)`);
    }
    assert.deepEqual(bad, []);
});
