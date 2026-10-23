import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    attestDir,
    computeReceiptMac,
    computeRepoState,
    getAttestationSecret,
    readEsoAttestation,
    verifySufficiencyReceipt,
    writeEsoAttestation,
} from '@mu/harness-foundation/pure';
import { buildTurnVerdict, isDeferredWritePath, resolveEsoPolicy } from '@mu/harness-eso-core';
import { recordGapToolUse, writeBundleStampFromPreflight } from '../packages/harness-host-generic/src/eso-gap-io.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_WRITE_TEMPLATE = path.join(ESO_ROOT, 'profiles/templates/hooks/guard-write.py');

function tempProductState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p2-product-state-'));
    return dir;
}

function tempConsumer(productStateRoot) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p2-consumer-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'hooks'), { recursive: true });

    // Copy guard-write.py into consumer
    const guardDest = path.join(root, '.cursor', 'hooks', 'guard-write.py');
    fs.copyFileSync(GUARD_WRITE_TEMPLATE, guardDest);
    fs.chmodSync(guardDest, 0o755);

    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'p2-test-project' } }),
    );

    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            paths: { locked: [], gated: ['src/'], ask: [] },
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'fail_closed',
                enforceWrites: 'fail_closed',
                sources: { law: { enabled: false }, code: { enabled: false }, memory: { enabled: false } },
            },
        }, null, 2),
    );

    return root;
}

function runPythonGuardWrite(guardScript, inputObj, env = {}) {
    return spawnSync('python3', [guardScript], {
        input: `${JSON.stringify(inputObj)}\n`,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

test('P2.1: writeEsoAttestation generates valid HMAC receipt with fingerprint, invIds, ttlSec', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    try {
        const projectId = 'proj-mac-01';
        const doc = writeEsoAttestation(projectId, {
            level: 'sufficient',
            score: 0.95,
            allowWrite: true,
            fingerprint: 'fp-blake2b-xyz',
            invIds: ['INV-001', 'INV-002'],
            ttlSec: 600,
        });

        assert.equal(doc.allowWrite, true);
        assert.equal(doc.fingerprint, 'fp-blake2b-xyz');
        assert.deepEqual(doc.invIds, ['INV-001', 'INV-002']);
        assert.equal(doc.ttlSec, 600);
        assert.ok(typeof doc.mac === 'string' && doc.mac.length === 64, 'MAC must be 64-char hex string');

        const readDoc = readEsoAttestation(projectId);
        assert.equal(readDoc.mac, doc.mac);

        // Verification succeeds
        const v = verifySufficiencyReceipt(projectId, 'fp-blake2b-xyz');
        assert.equal(v.valid, true);
        assert.equal(v.receipt.fingerprint, 'fp-blake2b-xyz');
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
    }
});

test('P2.1: verifySufficiencyReceipt detects tampering and a moved tree, not age', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    try {
        const projectId = 'proj-tamper';
        writeEsoAttestation(projectId, {
            level: 'insufficient',
            score: 0.40,
            allowWrite: false,
            fingerprint: 'fp-orig',
            invIds: ['INV-SEC-1'],
            ttlSec: 300,
        });

        // 1. Unadulterated insufficient receipt returns allow_write_false
        const v1 = verifySufficiencyReceipt(projectId, 'fp-orig');
        assert.equal(v1.valid, false);
        assert.equal(v1.reason, 'allow_write_false');

        // 2. Tampered file: agent forged allowWrite: true in product state file directly without updating MAC
        const receiptFile = path.join(pstate, 'attest', `${projectId}.json`);
        const raw = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        raw.allowWrite = true;
        fs.writeFileSync(receiptFile, JSON.stringify(raw, null, 2));

        const v2 = verifySufficiencyReceipt(projectId, 'fp-orig');
        assert.equal(v2.valid, false);
        assert.equal(v2.reason, 'mac_mismatch');

        // 3. Fingerprint mismatch (drift in repo or prompt)
        const docGood = writeEsoAttestation(projectId, {
            level: 'sufficient',
            score: 1.0,
            allowWrite: true,
            fingerprint: 'fp-good',
            ttlSec: 300,
        });
        const v3 = verifySufficiencyReceipt(projectId, 'fp-drifted');
        assert.equal(v3.valid, false);
        assert.equal(v3.reason, 'fingerprint_mismatch');

        // 4. An old receipt is NOT invalid by itself (G-21): age is not a fact about the tree.
        const oldAt = new Date(Date.now() - 400 * 1000).toISOString();
        writeEsoAttestation(projectId, {
            at: oldAt,
            level: 'sufficient',
            score: 1.0,
            allowWrite: true,
            fingerprint: 'fp-good',
            ttlSec: 300,
        });
        const v4 = verifySufficiencyReceipt(projectId, 'fp-good');
        assert.equal(v4.valid, true, 'a verdict about an unchanged tree stays true; the clock said nothing about the tree');
        assert.equal(v4.receipt.ttlSec, 300, 'ttlSec survives as a diagnostic, not as a gate');

        // 5. A tree that moved since the receipt is what invalidates it.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g21-root-'));
        try {
            const indexDir = path.join(root, '.git');
            fs.mkdirSync(indexDir, { recursive: true });
            const indexPath = path.join(indexDir, 'index');
            const mintedAt = new Date(Date.now() - 30_000);
            fs.writeFileSync(indexPath, 'x');
            fs.utimesSync(indexPath, mintedAt, mintedAt);
            writeEsoAttestation(projectId, {
                level: 'sufficient',
                score: 1.0,
                allowWrite: true,
                fingerprint: 'fp-good',
                repoState: computeRepoState(root),
            });
            assert.equal(verifySufficiencyReceipt(projectId, 'fp-good', { root }).valid, true);

            fs.utimesSync(indexPath, new Date(), new Date());
            const v5 = verifySufficiencyReceipt(projectId, 'fp-good', { root });
            assert.equal(v5.valid, false);
            assert.equal(v5.reason, 'repo_changed');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
    }
});

test('P2.2: recordGapToolUse allClosed promotes verdict to signed Sufficiency Receipt in Product State', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);

    try {
        const sessionPath = path.join(root, '.cursor', 'session');
        const preAt = new Date().toISOString();
        const preflight = {
            at: preAt,
            generationId: 'gen-test-p2',
            level: 'partial',
            score: 0.5,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            fingerprint: 'fp-task-123',
            pinnedInvariants: ['INV-001'],
            gaps: [{ kind: 'code', query: 'view_file src/index.ts' }],
        };
        fs.writeFileSync(path.join(sessionPath, '.eso-preflight.json'), JSON.stringify(preflight));

        // Initial attestation wrote allowWrite: false
        writeBundleStampFromPreflight(preflight, { eso: { enforceWrites: 'fail_closed' } }, root, 'cursor');
        const initialAttest = readEsoAttestation('p2-test-project');
        assert.equal(initialAttest.allowWrite, false);
        assert.equal(initialAttest.fingerprint, 'fp-task-123');

        // Now simulate agent closing the gap with tool use
        const res = recordGapToolUse(
            'view_file',
            { path: 'src/index.ts' },
            {
                root,
                tree: 'cursor',
                policy: { eso: { enforceWrites: 'fail_closed' } },
            },
        );

        assert.equal(res.allClosed, true);

        // Gap closure must have promoted the Product State Attestation to allowWrite: true with valid MAC
        const promotedAttest = readEsoAttestation('p2-test-project');
        assert.equal(promotedAttest.allowWrite, true);
        assert.equal(promotedAttest.level, 'sufficient');
        assert.equal(promotedAttest.fingerprint, 'fp-task-123');
        assert.ok(promotedAttest.mac);

        const v = verifySufficiencyReceipt('p2-test-project', 'fp-task-123');
        assert.equal(v.valid, true);
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('P2.1 & P2.2: guard-write.py enforces HMAC Sufficiency Receipt and blocks forged session stamps', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);
    const guardScript = path.join(root, '.cursor', 'hooks', 'guard-write.py');

    try {
        // Mock a recent Brain call in usage ledger so brain gate is satisfied
        fs.mkdirSync(pstate, { recursive: true });
        const brainLedger = path.join(pstate, 'deepseek-usage.jsonl');
        fs.writeFileSync(brainLedger, `${JSON.stringify({ role: 'pro', at: new Date().toISOString() })}\n`);

        const writePayload = {
            tool_name: 'Write',
            tool_input: {
                file_path: 'src/service.ts',
                contents: 'export const service = true;',
            },
        };

        // Case 1: Initial state (insufficient, allowWrite: false in product state) -> BLOCKED
        writeEsoAttestation('p2-test-project', {
            level: 'insufficient',
            score: 0.3,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            fingerprint: 'fp-initial',
        });

        const r1 = runPythonGuardWrite(guardScript, writePayload, {
            HARNESS_PRODUCT_STATE_DIR: pstate,
            HARNESS_TREE: 'cursor',
        });
        const out1 = JSON.parse(r1.stdout || '{}');
        assert.equal(out1.permission, 'deny');
        assert.ok(out1.user_message?.includes('ESO gate (fail-closed)'));

        // Case 2: Agent tries casual forgery by writing allowWrite: true in session stamp (.eso-bundle-stamp.json)
        fs.writeFileSync(
            path.join(root, '.cursor', 'session', '.eso-bundle-stamp.json'),
            JSON.stringify({
                ok: true,
                at: new Date().toISOString(),
                allowWrite: true,
                score: 0.99,
                mode: 'fail_closed',
            }),
        );

        // Guard must STILL DENY because Product State attestation has precedence and says allowWrite: false
        const r2 = runPythonGuardWrite(guardScript, writePayload, {
            HARNESS_PRODUCT_STATE_DIR: pstate,
            HARNESS_TREE: 'cursor',
        });
        const out2 = JSON.parse(r2.stdout || '{}');
        assert.equal(out2.permission, 'deny');

        // Case 3: Tampered Product State file (bad MAC) -> BLOCKED
        const attestFile = path.join(pstate, 'attest', 'p2-test-project.json');
        const forged = JSON.parse(fs.readFileSync(attestFile, 'utf8'));
        forged.allowWrite = true;
        forged.mac = 'badmac1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        fs.writeFileSync(attestFile, JSON.stringify(forged, null, 2));

        const r3 = runPythonGuardWrite(guardScript, writePayload, {
            HARNESS_PRODUCT_STATE_DIR: pstate,
            HARNESS_TREE: 'cursor',
        });
        const out3 = JSON.parse(r3.stdout || '{}');
        assert.equal(out3.permission, 'deny');

        // Case 4: Valid signed Sufficiency Receipt in Product State -> ALLOWED
        writeEsoAttestation('p2-test-project', {
            level: 'sufficient',
            score: 0.95,
            allowWrite: true,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            fingerprint: 'fp-valid',
            ttlSec: 600,
        });

        const r4 = runPythonGuardWrite(guardScript, writePayload, {
            HARNESS_PRODUCT_STATE_DIR: pstate,
            HARNESS_TREE: 'cursor',
        });
        const out4 = JSON.parse(r4.stdout || '{}');
        assert.equal(out4.permission, 'allow');
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('G-02: the deny says "every closable gap" when the gate exempted an unclosable one', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);
    const guardScript = path.join(root, '.cursor', 'hooks', 'guard-write.py');
    const writePayload = {
        tool_name: 'Write',
        tool_input: { file_path: 'src/service.ts', contents: 'export const service = true;' },
    };

    try {
        fs.mkdirSync(pstate, { recursive: true });
        fs.writeFileSync(
            path.join(pstate, 'deepseek-usage.jsonl'),
            `${JSON.stringify({ role: 'pro', at: new Date().toISOString() })}\n`,
        );

        // What atrievefin's consumer actually held: `partial`, one law gap nothing in that repo answers,
        // one code gap the agent can still close. The guard must refuse (correct) and must not tell the
        // agent to close the law gap (that advice is what could not be executed).
        writeEsoAttestation('p2-test-project', {
            level: 'partial',
            score: 0.55,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            enforceWritesSource: 'default',
            unanswerableGaps: [{ id: 'law:harness-tooling' }],
            fingerprint: 'fp-partial-g02',
        });

        const r = spawnSync('python3', [guardScript], {
            input: `${JSON.stringify(writePayload)}\n`,
            encoding: 'utf8',
            env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: pstate, HARNESS_TREE: 'cursor' },
        });
        const out = JSON.parse(r.stdout || '{}');
        const text = out.user_message || '';

        assert.equal(out.permission, 'deny');
        assert.match(text, /every closable gap/);
        assert.doesNotMatch(text, /every reported gap/, 'the old wording sent the reader after a document the repo lacks');
        assert.match(text, /law:harness-tooling/);
        assert.match(text, /NOT written/);
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('G-12: a tree that moved names the move only — not gaps it cannot fix', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);
    const guardScript = path.join(root, '.cursor', 'hooks', 'guard-write.py');

    try {
        fs.mkdirSync(pstate, { recursive: true });
        fs.writeFileSync(
            path.join(pstate, 'deepseek-usage.jsonl'),
            `${JSON.stringify({ role: 'pro', at: new Date().toISOString() })}\n`,
        );
        writeEsoAttestation('p2-test-project', {
            level: 'partial',
            score: 0.55,
            allowWrite: true,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            latencySeconds: 0,
            repoState: { indexMtime: 1_700_000_000_000, policyMtime: 1_700_000_000_000 },
            fingerprint: 'fp-moved',
        });

        const r = spawnSync('python3', [guardScript], {
            input: `${JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', contents: 'x' } })}\n`,
            encoding: 'utf8',
            env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: pstate, HARNESS_TREE: 'cursor' },
        });
        const text = JSON.parse(r.stdout || '{}').user_message || '';

        // The advice must describe *this* refusal: the tree moved, so re-measure — not the evidence
        // level, and not the policy lever, which were not what refused the write.
        assert.match(text, /working tree changed since this verdict was minted/);
        assert.doesNotMatch(text, /Close the remaining gaps/, 'a moved tree is one problem; the gap advice belongs to another');
        assert.doesNotMatch(text, /every .* gap/);
        assert.doesNotMatch(text, /enforceWrites.*NOT written/);
        assert.doesNotMatch(text, /TTL/);
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('G-21: an old receipt is valid — age stopped being a write condition', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);
    const guardScript = path.join(root, '.cursor', 'hooks', 'guard-write.py');

    try {
        fs.mkdirSync(pstate, { recursive: true });
        fs.writeFileSync(
            path.join(pstate, 'deepseek-usage.jsonl'),
            `${JSON.stringify({ role: 'pro', at: new Date().toISOString() })}\n`,
        );
        // The state atrievefin was refused in: `sufficient`, `allowWrite: true`, minted hours ago, and
        // nothing has been written to the tree since. The old guard refused on the clock alone.
        writeEsoAttestation('p2-test-project', {
            level: 'sufficient',
            score: 1,
            allowWrite: true,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
            ttlSec: 600,
            fingerprint: 'fp-old',
        });

        const run = () =>
            spawnSync('python3', [guardScript], {
                input: `${JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', contents: 'x' } })}\n`,
                encoding: 'utf8',
                env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: pstate, HARNESS_TREE: 'cursor' },
            });

        assert.equal(JSON.parse(run().stdout || '{}').permission, 'allow', 'five hours idle is not a change to the tree');

        // What an idle period cannot excuse: the stamp requirement is a different gate.
        fs.rmSync(path.join(pstate, 'deepseek-usage.jsonl'), { force: true });
        const noBrain = JSON.parse(run().stdout || '{}');
        assert.equal(noBrain.permission, 'deny');
        assert.match(noBrain.user_message || '', /Brain gate/);
        assert.doesNotMatch(noBrain.user_message || '', /older than its TTL/);
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('G-20: `deferWrite` defers evidence, not protection, and matches on a segment boundary', () => {
    const defer = { paths: ['SDLC/', './docs/plan', 'SRC\\legacy'], mode: 'evidence' };

    assert.equal(isDeferredWritePath(defer, 'SDLC/08.wbs/README.md'), true);
    assert.equal(isDeferredWritePath(defer, 'sdlc/08.wbs/README.md'), false, 'path matching is case-sensitive, as on disk');
    assert.equal(isDeferredWritePath(defer, 'SDLCX/README.md'), false, 'a sibling directory is not the deferred one');
    assert.equal(isDeferredWritePath(defer, 'docs/plan/2026.md'), true);
    assert.equal(isDeferredWritePath(defer, 'docs/plans/2026.md'), false);
    assert.equal(isDeferredWritePath(defer, 'SRC/legacy/a.ts'), true);
    assert.equal(isDeferredWritePath(defer, 'src/service.ts'), false);
    assert.equal(isDeferredWritePath({ paths: [] }, 'SDLC/x.md'), false);
    assert.equal(isDeferredWritePath(defer, ''), false);

    // The verdict carries the list verbatim so the guard can match it against the write it judges.
    const eso = resolveEsoPolicy({ eso: { mode: 'hint', preflight: { deferWrite: { paths: ['SDLC/'] } } } });
    assert.deepEqual(eso.preflight.deferWrite, { paths: ['SDLC/'], mode: 'evidence' });
    const verdict = buildTurnVerdict({
        requestId: 'req-g20',
        phase: 'preflight',
        measure: { score: 0.55, level: 'partial' },
        gaps: [{ kind: 'code', query: 'need at least 1 file read(s); have 0' }],
        eso,
    });
    assert.deepEqual(verdict.deferWrite, { paths: ['SDLC/'], mode: 'evidence' });
    assert.equal(verdict.allowProtectedWrite, false, 'deferral does not raise the level — the guard exempts the path, not the turn');
});

test('G-20: a gated `deferWrite` path is writable on `partial`, its siblings are not, and the stamp still applies', () => {
    const pstate = tempProductState();
    const origEnv = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = pstate;

    const root = tempConsumer(pstate);
    const guardScript = path.join(root, '.cursor', 'hooks', 'guard-write.py');

    try {
        // Consumed policy: the consumer keeps `SDLC/` gated but defers its evidence.
        const policyPath = path.join(root, '.harness', 'decision-policy.json');
        const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
        policy.paths.gated = ['src/', 'SDLC/'];
        policy.eso.preflight = { enabled: true, deferWrite: { paths: ['SDLC/'] } };
        fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));

        fs.mkdirSync(pstate, { recursive: true });
        fs.writeFileSync(
            path.join(pstate, 'deepseek-usage.jsonl'),
            `${JSON.stringify({ role: 'pro', at: new Date().toISOString() })}\n`,
        );

        // The state atrievefin actually sits in: `partial`, one closable gap still open (not allowWrite).
        writeEsoAttestation('p2-test-project', {
            level: 'partial',
            score: 0.55,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            unanswerableGaps: [{ id: 'law:harness-tooling' }],
            deferWrite: { paths: ['SDLC/'], mode: 'evidence' },
            fingerprint: 'fp-g20',
        });

        const run = (filePath) =>
            spawnSync('python3', [guardScript], {
                input: `${JSON.stringify({ tool_name: 'StrReplace', tool_input: { file_path: filePath, new_string: '22/65 SP' } })}\n`,
                encoding: 'utf8',
                env: { ...process.env, HARNESS_PRODUCT_STATE_DIR: pstate, HARNESS_TREE: 'cursor' },
            });

        const deferred = JSON.parse(run('SDLC/08.wbs/README.md').stdout || '{}');
        assert.equal(deferred.permission, 'allow', 'evidence is deferred for the declared path');

        const sibling = JSON.parse(run('SDLCX/README.md').stdout || '{}');
        assert.equal(sibling.permission, 'allow', 'not a protected path at all — nothing to defer');

        const source = JSON.parse(run('src/service.ts').stdout || '{}');
        assert.equal(source.permission, 'deny', 'a gated path outside the list still holds the evidence gate');

        // Protection was not deferred: the brain stamp is still required on the deferred path.
        fs.rmSync(path.join(pstate, 'deepseek-usage.jsonl'), { force: true });
        const noBrain = JSON.parse(run('SDLC/08.wbs/README.md').stdout || '{}');
        assert.equal(noBrain.permission, 'deny');
        assert.match(noBrain.user_message || '', /Brain gate/);
    } finally {
        if (origEnv !== undefined) process.env.HARNESS_PRODUCT_STATE_DIR = origEnv;
        else delete process.env.HARNESS_PRODUCT_STATE_DIR;
        fs.rmSync(pstate, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});
