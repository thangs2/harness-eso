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
    getAttestationSecret,
    readEsoAttestation,
    verifySufficiencyReceipt,
    writeEsoAttestation,
} from '@mu/harness-foundation/pure';
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

test('P2.1: verifySufficiencyReceipt detects tampering and expiration', () => {
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

        // 4. Expired receipt (> ttlSec)
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
        assert.equal(v4.valid, false);
        assert.equal(v4.reason, 'expired');
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
