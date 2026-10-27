import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BRAIN_WINDOW_SECONDS, resolveLedgerIndependently, surveyLedger } from '../packages/harness-cli/src/check-brain-cmd.mjs';

/*
 * `check brain` exists because the Brain gate's one disabling failure is silent: a sandbox that stops the
 * MCP child from writing the ledger leaves `brain_attested()` returning `{}`, and the resulting deny names
 * the Brain tier rather than the unwritten file. Three days of that went undiagnosed — the ledger's last
 * record was 2026-10-24 while the consumer believed Brain was configured.
 *
 * The cases below pin the four answers the check must not confuse with each other: missing, present but
 * empty of Brain rows, present but stale, and resolving to a different path than the product uses.
 */

const REC = (at, role = 'pro') => JSON.stringify({ ledger: 1, at, role, model: 'deepseek-v4-pro', httpStatus: 200, outcome: 'ok' });

function ledgerWith(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-brain-'));
    const file = path.join(dir, 'deepseek-usage.jsonl');
    fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
    return file;
}

const NOW = new Date('2026-10-27T12:00:00Z');

test('a missing ledger is reported as missing, not as stale', () => {
    const res = surveyLedger(path.join(os.tmpdir(), 'definitely-not-here.jsonl'), { now: NOW });
    assert.equal(res.exists, false);
    assert.equal(res.readable, false);
    assert.equal(res.error, 'ENOENT');
});

test('a ledger with only non-Brain roles reports no Brain records', () => {
    const file = ledgerWith([REC(NOW.toISOString(), 'flash'), REC(NOW.toISOString(), 'user')]);
    const res = surveyLedger(file, { now: NOW });
    assert.equal(res.exists, true);
    assert.equal(res.brainRecords, 0);
    assert.equal(res.newest, null);
    assert.equal(res.fresh, false);
});

test('a record inside the window is fresh, and the window matches the guard', () => {
    assert.equal(BRAIN_WINDOW_SECONDS, 30 * 60, 'must stay equal to STAMP_MAX_AGE_SECONDS in guard-write.py');
    const at = new Date(NOW.getTime() - 60_000).toISOString();
    const res = surveyLedger(ledgerWith([REC(at)]), { now: NOW });
    assert.equal(res.brainRecords, 1);
    assert.equal(res.ageSeconds, 60);
    assert.equal(res.fresh, true);
});

test('a record just outside the window is stale', () => {
    const at = new Date(NOW.getTime() - (BRAIN_WINDOW_SECONDS + 1) * 1000).toISOString();
    const res = surveyLedger(ledgerWith([REC(at)]), { now: NOW });
    assert.equal(res.fresh, false);
    assert.equal(res.ageSeconds, BRAIN_WINDOW_SECONDS + 1);
});

test('a timestamp from the future is not freshness (the guard refuses it too)', () => {
    const at = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const res = surveyLedger(ledgerWith([REC(at)]), { now: NOW });
    assert.equal(res.fresh, false);
    assert.ok(res.ageSeconds < 0);
});

test('the newest Brain record wins, and all three Brain roles count', () => {
    const old = new Date(NOW.getTime() - 3600_000).toISOString();
    const fresh = new Date(NOW.getTime() - 30_000).toISOString();
    const res = surveyLedger(ledgerWith([REC(old, 'pro'), REC(fresh, 'brain_fallback'), REC(fresh, 'brain_flash')]), { now: NOW });
    assert.equal(res.brainRecords, 3);
    assert.equal(res.newest.at, fresh);
    assert.equal(res.fresh, true);
});

test('malformed lines are counted but do not hide a valid record', () => {
    const at = new Date(NOW.getTime() - 60_000).toISOString();
    const res = surveyLedger(ledgerWith([REC(at), '{"half-flushed":', '']), { now: NOW });
    assert.equal(res.malformed, 1);
    assert.equal(res.brainRecords, 1);
    assert.equal(res.fresh, true);
});

test('the independent resolver honours the env override, then product state', () => {
    assert.deepEqual(resolveLedgerIndependently({ DEEPSEEK_USAGE_LEDGER: '/tmp/x.jsonl' }), {
        path: '/tmp/x.jsonl',
        source: 'DEEPSEEK_USAGE_LEDGER',
    });
    assert.deepEqual(resolveLedgerIndependently({ HARNESS_PRODUCT_STATE_DIR: '/tmp/ps' }), {
        path: '/tmp/ps/deepseek-usage.jsonl',
        source: 'product state',
    });
    // Neither set: the default is the operator's own product state, never the repo.
    assert.match(resolveLedgerIndependently({}).path, /\.harness[/\\]deepseek-usage\.jsonl$/);
});

test('a host that witnesses its own Brain calls is reported as passing, not as a missing ledger', async () => {
    /*
     * DSH records the call in the product-state attestation because its sandbox stops the MCP child from
     * writing the ledger. Reporting `ledger-missing` there would be a false alarm about a gate that is
     * working — and worse, it would send the operator to fix the ledger, which is the route that host
     * deliberately does not use.
     */
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'check-brain-witness-'));
    try {
        const { checkBrain } = await import('../packages/harness-cli/src/check-brain-cmd.mjs');
        const { recordBrainCall } = await import('../packages/harness-eso-dsh/src/brain-attestation.mjs');
        const { readEsoAttestation, writeEsoAttestation } = await import('../packages/harness-foundation/src/attest.mjs');

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-brain-consumer-'));
        fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ project: { id: 'witness-qc' } }));

        const before = checkBrain({ consumer: root });
        assert.ok(!before.witness?.used, 'nothing recorded yet (no witness block at all when the receipt has no brain record)');
        assert.ok(before.findings.some((f) => f.id === 'ledger-missing'), 'the ledger route is what it falls back to');

        writeEsoAttestation('witness-qc', { allowWrite: true, level: 'partial', source: 'dsh-plugin-checks' });
        recordBrainCall({ root, tool: 'mcp__deepseek-direct__ask_deepseek_pro', writeEsoAttestation, readEsoAttestation });

        const after = checkBrain({ consumer: root });
        assert.equal(after.witness.used, true);
        assert.equal(after.witness.fresh, true);
        assert.equal(after.verdict, 'pass');
        assert.equal(after.findings.length, 0, 'no ledger complaint where the host records its own calls');
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    }
});
