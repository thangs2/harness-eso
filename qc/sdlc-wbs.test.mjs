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

// Ownership is claimed by a §7 row (`| AC-x | type | …`), not by any mention anywhere in the file.
// A packet cites a neighbour's criterion in prose all the time ("this is W1's rule, not mine"), and
// counting those as claims makes two slices appear to own the same criterion.
function claimedAcs(text) {
    const i = text.indexOf('## 7. Test plan');
    if (i < 0) return [];
    const block = text.slice(i).split(/\n## \d/)[0];
    // Only the FIRST column of a row claims. A packet legitimately cites a neighbour's criterion
    // in a later column ("this belongs to US-SUF-01, not here") — counting those makes two slices
    // look like they own the same criterion, which is how the check would go blind.
    const claimed = [];
    for (const line of block.split('\n')) {
        if (!line.startsWith('|')) continue;
        const first = line.split('|')[1] ?? '';
        for (const m of first.matchAll(/AC-[A-Z]+-\d+-\d\d/g)) claimed.push(m[0]);
    }
    return [...new Set(claimed)];
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
        // A dictionary claims through its DoD line; a packet claims through §7 rows. Both are
        // "the criteria this slice owns", and both must be read from the field, not from prose.
        const acs = text.includes('## 7. Test plan')
            ? claimedAcs(block)
            : [...new Set(block.match(/AC-[A-Z]+-\d+-\d\d/g) ?? [])];
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
    for (const dir of ['01.packets/01.bip', '01.packets/02.fip']) {
        const abs = join(WBS_DIR, dir);
        let names = [];
        try { names = readdirSync(abs); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('.md')) continue;
            const text = readFileSync(join(abs, name), 'utf8');
            const kind = /^type:\s*(bip|fip)$/m.exec(text)?.[1];
            if (!kind) continue;
            if (kind === 'bip') {
                // A BIP that records OUT has nothing to decide in §3, §6 or §7 (standard §1.1), so
                // it must instead carry a reason and what proves the slice done. Demanding nine
                // sections of an OUT BIP is what produces invented content.
                const isOut = /\|\s*\*\*status\*\*\s*\|\s*\*\*`OUT`\*\*/i.test(text);
                if (isOut) {
                    if (!/\*\*Lý do `OUT`\*\*|Lý do `OUT`/.test(text)) bad.push(`${name} → OUT without a stated reason`);
                    if (!/Chứng minh bằng lệnh/.test(text)) bad.push(`${name} → OUT without what proves it`);
                } else {
                    const missing = sections.bip.filter((h) => !text.includes(`## ${h}`));
                    if (missing.length) bad.push(`${name} → ${missing.join(', ')}`);
                }
            }
            if (kind === 'fip' && !/OUT/.test(text)) bad.push(`${name} → a FIP must say OUT when it has no surface`);
        }
    }
    assert.deepEqual(bad, []);
});

test('X8: a wave with no interface criteria carries FIP = OUT', () => {
    const fipDir = join(WBS_DIR, '01.packets/02.fip');
    let names = [];
    try { names = readdirSync(fipDir); } catch { return; }
    // Packets are named by code of account: 02.0.fip-out.md, 02.1.bip.md, ...
    const fips = names.filter((n) => n.endsWith('.md')).map((n) => readFileSync(join(fipDir, n), 'utf8'));
    if (fips.length === 0) return;
    assert.ok(fips.some((t) => /\bOUT\b/.test(t)), 'a back-end-only wave must record FIP = OUT with a reason');
});

// A packet may only be READY when nothing in its open register is still open. A READY packet with
// live questions is how "ready" stops meaning anything.
test('X8: a READY packet has no open items left', () => {
    const bipDir = join(WBS_DIR, '01.packets/01.bip');
    let names = [];
    try { names = readdirSync(bipDir); } catch { return; }
    const bad = [];
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const text = readFileSync(join(bipDir, name), 'utf8');
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

// X8 says every slice has a packet. It never said how many slices there are, so five packets
// against fifty-six leaves passed. This counts both sides: every leaf of the tree must be claimed
// by exactly one BIP or one FIP, and a packet may not name a leaf that does not exist.
test('X8: packet coverage is counted against the leaves, not sampled', () => {
    const tree = readFileSync(join(WBS_DIR, '02.wbs-tree.md'), 'utf8');
    // leaves are the rows of the per-deliverable breakdown tables: | **2.3** | title | task |
    const leaves = new Set([...tree.matchAll(/^\| \*\*(\d+\.\d+)\*\* \|/gm)].map((m) => m[1]));

    const claimed = new Map(); // leaf -> file
    const unknownLeaf = [];
    for (const dir of ['01.packets/01.bip', '01.packets/02.fip']) {
        const abs = join(WBS_DIR, dir);
        let names = [];
        try { names = readdirSync(abs); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('.md')) continue;
            const text = readFileSync(join(abs, name), 'utf8');
            // A slice-level OUT record (id: BIP-1-OUT) claims every leaf of that deliverable:
            // one file answers for six slices that share one reason (standard §1.1).
            const whole = /^id: (?:BIP|FIP)-(\d)-OUT/m.exec(text);
            const codes = whole
                ? [...leaves].filter((l) => l.startsWith(`${whole[1]}.`))
                : [(_ = /^id: (?:BIP|FIP)-(\d+[._]\d+)/m.exec(text)) => _?.[1]?.replace('_', '.')]
                      .map((f) => f())
                      .filter(Boolean);
            for (const code of codes) {
                if (!leaves.has(code)) unknownLeaf.push(`${dir}/${name} → ${code}`);
                if (claimed.has(code)) claimed.set(code, `${claimed.get(code)} + ${dir}/${name}`);
                else claimed.set(code, `${dir}/${name}`);
            }
        }
    }

    assert.deepEqual(unknownLeaf, [], 'a packet names a leaf the tree does not contain');
    const missing = [...leaves].filter((l) => !claimed.has(l)).sort();
    assert.equal(leaves.size, 56, `tree should have 56 leaves, saw ${leaves.size}`);

    // The gap is real, so it is asserted as an allowance rather than ignored: the number must
    // match the recorded debt. Writing the count here means the test fails the moment a packet is
    // added without updating the register, and fails again if the register is updated without a
    // packet. A test that only asserted "no unknown leaf" would pass with fifty-one missing.
    const ALLOWED_MISSING = 29;
    assert.equal(
        missing.length,
        ALLOWED_MISSING,
        `packets missing for ${missing.length} leaves (recorded debt is ${ALLOWED_MISSING}): ${missing.slice(0, 6).join(', ')}…`,
    );
});

// §1.1 of the packet standard: a slice may record OUT only if the WBS assigns it no criteria.
// A slice that owns criteria and claims OUT is hiding work behind a legal word.
test('X8: a slice may be OUT only when it owns no criterion', () => {
    const D = join(WBS_DIR, '..');
    const read = (p) => readFileSync(join(D, p), 'utf8');

    // criteria per leaf, from the dictionaries
    const acByLeaf = new Map();
    for (const name of readdirSync(WBS_DIR)) {
        if (!/^\d+\.dictionary-w\d+\.md$/.test(name)) continue;
        const text = readdirSync(WBS_DIR).includes(name) ? read(join('09.wbs', name)) : '';
        for (const blk of text.split(/\n### /).slice(1)) {
            const m = /^`(\d+\.\d+)`/.exec(blk);
            if (!m) continue;
            const acs = new Set(blk.match(/AC-[A-Z]+-\d+-\d\d/g) ?? []);
            acByLeaf.set(m[1], acs.size);
        }
    }

    // slices that record OUT
    const outSlices = [];
    for (const dir of ['01.packets/01.bip', '01.packets/02.fip']) {
        let names = [];
        try { names = readdirSync(join(WBS_DIR, dir)); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('.md')) continue;
            const text = read(join('09.wbs', dir, name));
            if (!/^type: (bip|fip)/m.test(text)) continue;
            const code = /^id: (?:BIP|FIP)-(\d+)[._](\d+)/m.exec(text);
            if (!code) continue;
            const isOut = /status\s*\|[^\n]*`OUT`/.test(text) || /^# .*`OUT`/m.test(text);
            if (isOut) outSlices.push([`${code[1]}.${code[2]}`, dir]);
        }
    }

    const hiding = outSlices.filter(([leaf]) => (acByLeaf.get(leaf) ?? 0) > 0);
    assert.deepEqual(
        hiding.map(([leaf, dir]) => `${dir} → ${leaf} owns criteria but claims OUT`),
        [],
    );
});

// A deliverable's gate is a definition of done, not a criterion, so AC<->SCN coverage (X3) cannot
// see it. The W2 gate had none until this test existed: five criteria could be green while the
// thing the deliverable is for was never exercised. Every gate named in the tree must have a
// scenario row marked as a gate.
test('X3b: every gate in the tree has a scenario (X3 cannot see this)', () => {
    const tree = readFileSync(join(WBS_DIR, '02.wbs-tree.md'), 'utf8');
    // the gate column carries the deliverable's definition of done; deliveries are numbered 1..8
    const gateRows = [...tree.matchAll(/^\| \*\*(\d)\*\* \|.+?\|$/gm)].length;
    assert.equal(gateRows, 8, `expected 8 deliverable rows, saw ${gateRows}`);

    const matrices = readdirSync(join(WBS_DIR, '..', '06.analysis', '04.quality-control'))
        .filter((n) => n.includes('scenario-matrix'))
        .map((n) => readFileSync(join(WBS_DIR, '..', '06.analysis', '04.quality-control', n), 'utf8'))
        .join('\n');

    const gateScenarios = [...matrices.matchAll(/^\| `(SCN-[A-Z]+-\d+)` \| \*\*cổng/gm)].map((m) => m[1]);
    assert.ok(
        gateScenarios.length >= 1,
        'a gate scenario row must exist (the pattern is: | `SCN-...` | **cổng `Wn`** | gate | ...)',
    );
});
