import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEsoAttestation, writeEsoAttestation } from '../packages/harness-foundation/src/attest.mjs';
import { writeDshAttestation } from '../packages/harness-eso-dsh/src/attestation.mjs';
import { isCompletedBrainCall, recordBrainCall } from '../packages/harness-eso-dsh/src/brain-attestation.mjs';

/*
 * Receipts are minted through `writeDshAttestation`, not by hand: `guard-write.py` derives the evidence
 * gate from `mode`/`enforceWrites`, and a receipt written without them reads as `gate: unknown` — which
 * silently turns the evidence gate off. A test that writes its own fixture would not notice that the
 * plugin's path supplies them.
 */
const POLICY = { eso: { mode: 'hint', enforceWrites: 'fail_closed' } };

/*
 * A on DSH: the plugin witnesses the Brain call instead of reading a ledger the sandbox prevents.
 *
 * The root-cause note offered two remedies — point `DEEPSEEK_USAGE_LEDGER` into the writable set, or widen
 * the sandbox. Both are wrong for the same reason: the only writable set inside a workspace is one the
 * agent can also write, so either remedy turns into "the gated party writes its own evidence". The third
 * option is the one taken here: a host pipeline listener observes the tool result. The agent cannot emit
 * a `tools/post-execute`, cannot reach product state through Write/Shell, and cannot replay a paid model
 * call for free.
 *
 * These cases pin the trust properties, not just the happy path.
 */

const GUARD = path.resolve(import.meta.dirname, '../profiles/templates/hooks/guard-write.py');

function consumer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ project: { id: 'dsh-brain-qc' } }));
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            paths: { locked: [], gated: ['sdlc/'], ask: [] },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'fail_closed', cognition: { enforceBrain: 'fail_closed' } },
        }),
    );
    fs.copyFileSync(GUARD, path.join(root, '.cursor', 'hooks', 'guard-write.py'));
    return root;
}

function withState(fn) {
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-state-'));
    process.env.HARNESS_PRODUCT_STATE_DIR = dir;
    try {
        return fn(dir);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    }
}

function write(root) {
    const res = spawnSync('python3', [path.join(root, '.cursor', 'hooks', 'guard-write.py')], {
        input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 's',
            cwd: root,
            tool_name: 'Write',
            tool_input: { file_path: 'sdlc/x.md', content: 'hi' },
        }),
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_TREE: 'cursor' },
    });
    return JSON.parse(res.stdout || '{}')?.hookSpecificOutput ?? {};
}

test('only a non-error result from a Brain-tier tool counts', () => {
    const ok = { name: 'mcp__deepseek-direct__ask_deepseek_pro' };
    assert.equal(isCompletedBrainCall(ok, { isError: false }), true);
    assert.equal(isCompletedBrainCall(ok, {}), true, 'a result with no isError is a success');
    assert.equal(isCompletedBrainCall(ok, { isError: true }), false, 'a failed call attests nothing');
});

test('the cheap flash tier and any other tool are not Brain evidence', () => {
    for (const name of [
        'mcp__deepseek-direct__ask_deepseek_flash',
        'mcp__other-server__ask_deepseek_pro',
        'write',
        'Bash',
        '',
    ]) {
        assert.equal(isCompletedBrainCall({ name }, {}), false, `${name} must not satisfy the Brain gate`);
    }
});

test('a recorded call satisfies the guard with no ledger and no stamp', () => {
    const root = consumer();
    withState(() => {
        writeDshAttestation({ root, policy: POLICY, blockers: [], errors: [] });
        assert.match(write(root).permissionDecisionReason ?? '', /Brain gate/, 'the evidence gate is satisfied, Brain is not');

        const res = recordBrainCall({ root, tool: 'mcp__deepseek-direct__ask_deepseek_pro', writeEsoAttestation, readEsoAttestation });
        assert.equal(res.written, true, res.reason);
        assert.equal(write(root).permissionDecision, 'allow', 'the witnessed call is the evidence');
    });
});

test('recording a Brain call never resets the evidence verdict', () => {
    /*
     * The two gates answer different questions. A Brain call must not flip `allowWrite` on, and a refused
     * evidence verdict must survive the recording — otherwise "reason before you write" becomes a way to
     * overwrite "is there enough context".
     */
    const root = consumer();
    withState(() => {
        writeDshAttestation({ root, policy: POLICY, blockers: [{ id: 'check-1' }], errors: [] });
        const res = recordBrainCall({ root, tool: 'mcp__deepseek-direct__ask_deepseek', writeEsoAttestation, readEsoAttestation });
        assert.equal(res.doc.allowWrite, false, 'a Brain call does not grant evidence sufficiency');
        assert.equal(res.doc.level, 'insufficient');
        assert.equal(res.doc.brain.brainTier, 'ask_deepseek');
        // The guard must still refuse: the evidence gate speaks first.
        // `deny_eso_message` speaks for this gate; "ESO gate" is only the terse constant it replaces.
        assert.match(write(root).permissionDecisionReason ?? '', /protected write refused/);
    });
});

test('a call older than the window stops satisfying the gate', () => {
    const root = consumer();
    withState(() => {
        writeDshAttestation({ root, policy: POLICY, blockers: [], errors: [] });
        recordBrainCall({ root, tool: 'mcp__deepseek-direct__ask_deepseek_pro', writeEsoAttestation, readEsoAttestation });
        // Age the record by rewriting it, the way a real session would age in place.
        const doc = readEsoAttestation('dsh-brain-qc');
        const old = new Date(Date.now() - 31 * 60_000).toISOString();
        writeEsoAttestation('dsh-brain-qc', { ...doc, at: old, brain: { ...doc.brain, at: old } });
        assert.match(write(root).permissionDecisionReason ?? '', /Brain gate/, 'outside 30 minutes is not evidence');
    });
});

test('the denial on a witnessing host points at the tool, not at a stamp or a dead ledger', () => {
    /*
     * The message is the one artefact a model reads under a fail-closed gate, so it decides what the
     * agent does next. On a host that records calls itself, "write the session stamp" and "fix the ledger"
     * are both wrong instructions: the stamp is agent-writable evidence, and the ledger is a file that
     * host's sandbox prevents anyone from writing. Sending a reader there produces a confident wrong
     * action — the failure mode this whole fix exists to remove.
     */
    const root = consumer();
    withState(() => {
        writeDshAttestation({ root, policy: POLICY, blockers: [], errors: [] });
        const reason = write(root).permissionDecisionReason ?? '';
        assert.match(reason, /Brain gate/);
        assert.match(reason, /Call a Brain-tier tool/, 'names the one action that works');
        assert.match(reason, /no stamp to write/, 'says the stamp is not the remedy here');
        assert.doesNotMatch(reason, /set DEEPSEEK_USAGE_LEDGER/, 'never sends the reader to a path the sandbox blocks');
    });
});

test('a ledger row written by another process still counts where the ledger is the evidence', () => {
    /*
     * The witness is additive: Cursor and Antigravity keep the ledger route exactly as before, and a
     * receipt minted by the pack must not lose that. Pinned because "attestation first" could otherwise
     * be read as "attestation only".
     */
    const root = consumer();
    withState((state) => {
        const ledger = path.join(state, 'deepseek-usage.jsonl');
        fs.writeFileSync(ledger, `${JSON.stringify({ ledger: 1, at: new Date().toISOString(), role: 'pro', outcome: 'ok' })}\n`);
        writeDshAttestation({ root, policy: POLICY, blockers: [], errors: [] });
        const res = spawnSync('python3', [path.join(root, '.cursor', 'hooks', 'guard-write.py')], {
            input: JSON.stringify({
                hook_event_name: 'PreToolUse',
                session_id: 's',
                cwd: root,
                tool_name: 'Write',
                tool_input: { file_path: 'sdlc/x.md', content: 'hi' },
            }),
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, HARNESS_TREE: 'cursor', DEEPSEEK_USAGE_LEDGER: ledger },
        });
        assert.equal(JSON.parse(res.stdout || '{}').hookSpecificOutput?.permissionDecision, 'allow', 'the ledger still satisfies the gate');
    });
});
