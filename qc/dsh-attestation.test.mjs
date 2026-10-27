import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * The DSH plugin has to write the ESO attestation itself: `guard-write.py` prefers
 * `<product-state>/attest/<pid>.json`, DSH has no command hooks, and nothing told the plugin to write
 * one. With `enforceWrites: fail_closed` the guard therefore refused every protected write for missing
 * evidence — before the Brain gate was consulted — and the refusal read like a policy problem.
 *
 * These cases pin the three properties that make the receipt worth reading: it is written outside the
 * agent's Write path, it says `allowWrite: false` when a check actually blocked, and guard-write.py
 * consumes it (so the two halves are proven to agree rather than assumed to).
 */

const STATE = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-'));
const GUARD = path.resolve(import.meta.dirname, '../profiles/templates/hooks/guard-write.py');

/** A fresh product state per case: the receipt path is machine-wide and would leak between tests. */
function body(fn) {
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    const dir = STATE();
    process.env.HARNESS_PRODUCT_STATE_DIR = dir;
    return Promise.resolve(fn(dir)).finally(() => {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    });
}

function consumer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-consumer-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ project: { id: 'dsh-attest-qc' } }));
    return root;
}

/** The plugin modules read product state from the env, so each case gets its own. */
function withState(fn) {
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    const dir = STATE();
    process.env.HARNESS_PRODUCT_STATE_DIR = dir;
    try {
        return fn(dir);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    }
}

test('a verdict with no blocker attests allowWrite and lands in product state', async () => {
    const { writeDshAttestation, receiptMatchesVerdict } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const root = consumer();
    await withState((dir) => {
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), false, 'no attestation before the first step');
        const res = writeDshAttestation({ root, policy: { eso: { mode: 'hint', enforceWrites: 'fail_closed' } } });
        assert.equal(res.written, true, res.reason);
        assert.equal(res.doc.allowWrite, true);
        assert.equal(res.doc.level, 'partial', 'a check-only verdict never claims sufficiency');
        assert.equal(res.doc.source, 'dsh-plugin-checks', 'the receipt says who minted it');
        assert.ok(fs.existsSync(path.join(dir, 'attest', 'dsh-attest-qc.json')), 'written to product state');
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), true);
    });
});

test('a hard blocker attests allowWrite:false rather than a writable verdict', async () => {
    const { writeDshAttestation } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const root = consumer();
    await withState(() => {
        const res = writeDshAttestation({ root, blockers: [{ id: 'check-1' }], errors: [] });
        assert.equal(res.doc.allowWrite, false, 'a failed check must not attest a writable tree');
        assert.equal(res.doc.level, 'insufficient');
    });
});

test('an unreadable product state is reported, never thrown', async () => {
    const { writeDshAttestation } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const root = consumer();
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    // A file where a directory must be: every mkdir under it fails.
    const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-blocked-')), 'file');
    fs.writeFileSync(notADir, 'x');
    process.env.HARNESS_PRODUCT_STATE_DIR = notADir;
    try {
        const res = writeDshAttestation({ root });
        assert.equal(res.written, false, 'the caller must get a result, not an exception');
        assert.ok(res.reason, 'and a reason');
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    }
});

test('guard-write.py consumes the attestation the plugin wrote (the two halves agree)', async () => {
    /*
     * Without the attestation the ESO gate refuses for missing evidence; with it, the very same write
     * must get past the evidence gate and stop at the Brain gate instead. If this case ever shows ESO
     * refusing again, the writer and the reader have diverged — which is the exact defect C fixes.
     */
    const { writeDshAttestation } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const root = consumer();
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            paths: { locked: [], gated: ['sdlc/'], ask: [] },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'fail_closed', cognition: { enforceBrain: 'fail_closed' } },
        }),
    );
    const dest = path.join(root, '.cursor', 'hooks', 'guard-write.py');
    fs.copyFileSync(GUARD, dest);

    const inputs = JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: 'sdlc/x.md', content: 'hi' },
    });
    const run = (stateDir) =>
        spawnSync('python3', [dest], {
            input: inputs,
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: stateDir, HARNESS_TREE: 'cursor' },
        });

    await withState((dir) => {
        /*
         * The negative half is a `blockers: []` receipt that forbids the write — the shape the plugin
         * produces when a consumer *has* an attestation and a check said no. A consumer that never had
         * one is a different case: the guard finds no verdict at all (deliberately tolerant, since a
         * pack that has not been refreshed must not brick every write), so it cannot be used to prove
         * that the receipt is being read.
         */
        writeDshAttestation({ root, policy: { eso: { mode: 'hint', enforceWrites: 'fail_closed' } }, blockers: [{ id: 'c' }], errors: [] });
        const before = run(dir);
        assert.match(before.stdout, /ESO gate/, 'a receipt that forbids the write is the evidence gate speaking');

        writeDshAttestation({ root, policy: { eso: { mode: 'hint', enforceWrites: 'fail_closed' } }, blockers: [], errors: [] });
        const after = run(dir);
        assert.match(after.stdout, /Brain gate/, 'the evidence gate is satisfied by the receipt');
        assert.doesNotMatch(after.stdout, /ESO gate/, 'and no longer refuses');
    });
});

test('a receipt is rewritten when the verdict flips, in either direction', async () => {
    /*
     * The bug this case exists for: the first version skipped the write whenever a receipt already said
     * `allowWrite: true`. A check that then started failing never replaced it, so the guard kept reading
     * the old allow and admitted the write the current step had just blocked. A gate cannot report a
     * failure and permit the write.
     */
    const { receiptMatchesVerdict, writeDshAttestation } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const root = consumer();
    await body(() => {
        // Nothing on disk: nothing to match.
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), false);

        writeDshAttestation({ root, blockers: [], errors: [] });
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), true, 'same verdict: do not rewrite');
        assert.equal(receiptMatchesVerdict(root, { allowWrite: false }), false, 'a blocker appeared: rewrite');

        writeDshAttestation({ root, blockers: [{ id: 'b' }], errors: [] });
        assert.equal(receiptMatchesVerdict(root, { allowWrite: false }), true);
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), false, 'blocker cleared: rewrite');

        writeDshAttestation({ root, blockers: [], errors: [] });
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), true);
    });
});

test('a receipt minted by the pack is never overwritten by the plugin', async () => {
    /*
     * The pack's receipt carries a docgraph/codegraph measurement this plugin cannot reproduce. Replacing
     * it with a check-only verdict would weaken the evidence the guard trusts.
     */
    const { receiptMatchesVerdict, writeDshAttestation } = await import('../packages/harness-eso-dsh/src/attestation.mjs');
    const { writeEsoAttestation } = await import('../packages/harness-foundation/src/attest.mjs');
    const root = consumer();
    await body(() => {
        writeEsoAttestation('dsh-attest-qc', { allowWrite: true, level: 'sufficient', score: 0.9, invIds: [] });
        assert.equal(
            receiptMatchesVerdict(root, { allowWrite: true }),
            false,
            'a measured receipt is not this plugin\'s to keep — and must not be treated as one of ours',
        );

        writeDshAttestation({ root, blockers: [], errors: [] });
        assert.equal(receiptMatchesVerdict(root, { allowWrite: true }), true);
    });
});
