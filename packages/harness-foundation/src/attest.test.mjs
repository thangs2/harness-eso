import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    attestDir,
    brainAttested,
    readEsoAttestation,
    usageLedgerFile,
    writeEsoAttestation,
} from './attest.mjs';

/**
 * Attestations are the guards' trust anchors. The property that matters is **who can write them**, so most
 * of these tests are about location and provenance rather than JSON handling.
 */

function withState(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-attest-'));
    const prevState = process.env.HARNESS_PRODUCT_STATE_DIR;
    const prevLedger = process.env.DEEPSEEK_USAGE_LEDGER;
    process.env.HARNESS_PRODUCT_STATE_DIR = root;
    delete process.env.DEEPSEEK_USAGE_LEDGER;
    try {
        return fn(root);
    } finally {
        if (prevState === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prevState;
        if (prevLedger === undefined) delete process.env.DEEPSEEK_USAGE_LEDGER;
        else process.env.DEEPSEEK_USAGE_LEDGER = prevLedger;
    }
}

const ledgerLine = (over = {}) =>
    `${JSON.stringify({
        ledger: 1,
        at: new Date().toISOString(),
        role: 'brain_flash',
        promptSha256: 'x'.repeat(64),
        model: 'deepseek-flash',
        ...over,
    })}\n`;

test('attestations live in product state, not in the repo session dir', () => {
    /*
     * The whole point. The session directory must stay agent-writable — the agent's own Brain stamp and
     * the pack's preflight bundle are written there — so a trust anchor beside them is one the gated party
     * can edit. A real incident did exactly that: overwrote `allowWrite`, invented a score, and added a
     * `hilWaiver` field that exists nowhere in the codebase.
     */
    withState((root) => {
        assert.equal(attestDir(), path.join(root, 'attest'));
        assert.doesNotMatch(attestDir(), /session/);
    });
});

test('an absent attestation is null, not a default that permits', () => {
    withState(() => {
        assert.equal(readEsoAttestation('p'), null);
        assert.equal(readEsoAttestation(''), null);
    });
});

test('a written attestation round-trips, carrying the verdict the gate consumes', () => {
    withState(() => {
        writeEsoAttestation('p', {
            level: 'insufficient',
            score: 0.3667,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'fail_closed',
            generationId: 'gen-1',
        });
        const doc = readEsoAttestation('p');
        assert.equal(doc.allowWrite, false);
        assert.equal(doc.level, 'insufficient');
        assert.equal(doc.score, 0.3667);
        assert.equal(doc.generationId, 'gen-1');
        assert.ok(Date.parse(doc.at));
    });
});

test('allowWrite defaults to false — an attestation must not grant by omission', () => {
    // `allowWrite: input?.allowWrite === true` rather than `!== false`: a caller that forgets the field is
    // stating nothing, and a gate that reads "nothing" as permission is the bug this replaces.
    withState(() => {
        assert.equal(writeEsoAttestation('p', { level: 'sufficient' }).allowWrite, false);
        assert.equal(writeEsoAttestation('p', { allowWrite: true }).allowWrite, true);
    });
});

test('a corrupt attestation reads as absent', () => {
    withState(() => {
        const dir = attestDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'p.json'), '{ not json');
        assert.equal(readEsoAttestation('p'), null);
    });
});

test('a Brain-tier ledger record attests a Brain call', () => {
    withState(() => {
        fs.writeFileSync(usageLedgerFile(), ledgerLine({ role: 'brain_flash' }));
        assert.equal(brainAttested().ok, true);
        assert.equal(brainAttested().role, 'brain_flash');
    });
});

test('pro and brain_fallback roles attest; executor does not', () => {
    /*
     * The executor is thinking-off Fast-tier tooling. Counting it would let a merge call open the Brain
     * gate, which is the same conflation that made `ask_deepseek_flash` look like a Brain call in the
     * observer's classification.
     */
    withState(() => {
        for (const role of ['pro', 'brain_flash', 'brain_fallback']) {
            fs.writeFileSync(usageLedgerFile(), ledgerLine({ role }));
            assert.equal(brainAttested().ok, true, `${role} must attest`);
        }
        for (const role of ['executor', '', 'flash']) {
            fs.writeFileSync(usageLedgerFile(), ledgerLine({ role }));
            assert.equal(brainAttested().ok, false, `${role} must not attest`);
        }
    });
});

test('an old Brain call does not attest', () => {
    // Same window the session stamp used, so migrating to the ledger does not quietly widen the gate.
    withState(() => {
        const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
        fs.writeFileSync(usageLedgerFile(), ledgerLine({ at: old }));
        assert.equal(brainAttested().ok, false);

        const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        fs.writeFileSync(usageLedgerFile(), ledgerLine({ at: fresh }));
        assert.equal(brainAttested().ok, true);
    });
});

test('a record from the future is refused rather than treated as fresh', () => {
    // A clock problem must not become a permanent approval.
    withState(() => {
        const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        fs.writeFileSync(usageLedgerFile(), ledgerLine({ at: future }));
        assert.equal(brainAttested().ok, false);
    });
});

test('a missing ledger is not an error, and neither is a malformed line', () => {
    withState(() => {
        assert.equal(brainAttested().ok, false, 'missing');
        fs.writeFileSync(usageLedgerFile(), 'not json\n' + ledgerLine());
        assert.equal(brainAttested().ok, true, 'a bad line must not hide a good one after it');
    });
});

test('only the tail of the ledger is read, and a fragmented first line is tolerated', () => {
    /*
     * The ledger is append-only and unbounded. A gate runs on every guarded write, so scanning megabytes
     * is not acceptable — and a tail read begins mid-record, which must be skipped rather than crash.
     */
    withState(() => {
        const filler = Array.from({ length: 4000 }, (_, i) =>
            ledgerLine({ role: 'executor', promptSha256: String(i), pad: 'z'.repeat(200) }),
        ).join('');
        fs.writeFileSync(usageLedgerFile(), filler + ledgerLine({ role: 'pro' }));
        assert.equal(brainAttested().ok, true, 'a recent pro call at the end is still found');

        // The same file with the pro record far enough back to fall outside the tail window.
        fs.writeFileSync(usageLedgerFile(), ledgerLine({ role: 'pro' }) + filler);
        assert.equal(brainAttested().ok, false, 'and is not found once it is out of the window');
    });
});

test('the newest Brain call wins, so an older executor record cannot mask it', () => {
    withState(() => {
        fs.writeFileSync(
            usageLedgerFile(),
            ledgerLine({ role: 'pro', at: new Date(Date.now() - 60_000).toISOString() }) +
                ledgerLine({ role: 'executor' }),
        );
        assert.equal(brainAttested().ok, true);
    });
});
