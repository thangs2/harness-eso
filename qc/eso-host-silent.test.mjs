import test from 'node:test';
import assert from 'node:assert/strict';

import {
    handleMidTurnBranchFailure,
    invokeCapabilityProvider,
    ERROR_SILENT_SWITCH,
    ERROR_SILENT_NONE,
} from '../eso/adapters/src/election.mjs';

test('ESO-383 / B5: SILENT_SWITCH and SILENT_NONE constants exist', () => {
    assert.equal(ERROR_SILENT_SWITCH, 'SILENT_SWITCH');
    assert.equal(ERROR_SILENT_NONE, 'SILENT_NONE');
});

test('ESO-383 / B5: Missing failure reason or silent switch throws SILENT_SWITCH', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'host-native',
        provider_id: 'cursor-codegraph',
    };

    // 1. Missing failureReason throws SILENT_SWITCH
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: '',
                branches: { 'eso-native': { available: true } },
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_SWITCH');
            return true;
        }
    );

    // 2. silent: true throws SILENT_SWITCH
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: 'Socket timeout',
                branches: { 'eso-native': { available: true } },
                silent: true,
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_SWITCH');
            return true;
        }
    );
});

test('ESO-383 / B5: Silent fallback to none throws SILENT_NONE', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'external',
        provider_id: 'ext-cg',
    };

    // Attempting silent fallback to none
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: 'Provider uninstalled',
                branches: {}, // all next branches empty -> falls back to none
                silentNone: true,
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_NONE');
            return true;
        }
    );
});

test('ESO-383 / B5: Non-silent mid-turn branch switch records record and reason explicitly', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'host-native',
        provider_id: 'cursor-codegraph',
        history: [{ branch: 'host-native', status: 'elected' }],
    };

    const res = handleMidTurnBranchFailure({
        currentElection: election,
        failureReason: 'Host CLI crashed',
        branches: {
            'eso-native': { available: true, provider_id: 'eso-codegraph' },
        },
    });

    assert.equal(res.switched, true);
    assert.equal(res.branch, 'eso-native');
    assert.equal(res.previous_branch, 'host-native');
    assert.ok(res.switch_record);
    assert.equal(res.switch_record.from, 'host-native');
    assert.equal(res.switch_record.to, 'eso-native');
    assert.equal(res.switch_record.reason, 'Host CLI crashed');
    assert.equal(res.switch_record.silent, false);
    assert.ok(res.history.some((h) => h.status === 'failed' && h.reason === 'Host CLI crashed'));
});

test('ESO-383: invokeCapabilityProvider on zero-source branch none throws SILENT_NONE', () => {
    const noneElection = {
        turn_id: 'turn-silent-1',
        capability: 'codegraph_query',
        branch: 'none',
        provider_id: null,
    };

    assert.throws(
        () => invokeCapabilityProvider(noneElection, () => {}),
        (err) => {
            assert.equal(err.code, 'SILENT_NONE');
            return true;
        }
    );
});

test('ESO-382: election reads capability_pin from DB store and queryTurnProviderAudit reads evidence_item', async () => {
    const { createDbAdapter } = await import('../eso/graph/src/db-adapter.mjs');
    const {
        electCapabilityProvider,
        setCapabilityPin,
        queryTurnProviderAudit,
    } = await import('../eso/adapters/src/election.mjs');
    const { ensureEvidenceSchema, recordTurnEvidence } = await import('../eso/adapters/src/host-bridge.mjs');

    const db = createDbAdapter(':memory:');
    ensureEvidenceSchema(db);

    // 1. Set pin in DB
    setCapabilityPin({
        project: 'proj-pin-test',
        capabilityKind: 'codegraph',
        targetBranch: 'eso-native',
        db,
    });

    // 2. Election without pins argument reads from DB
    const election = electCapabilityProvider({
        project: 'proj-pin-test',
        turnId: 'turn-pin-1',
        capabilityKind: 'codegraph',
        host: 'cursor',
        branches: {
            'host-native': { available: true, provider_id: 'cursor-cg' },
            'eso-native': { available: true, provider_id: 'eso-cg' },
        },
        db,
    });
    assert.equal(election.branch, 'eso-native', 'Must elect pinned branch from DB');
    assert.equal(election.pinned, true);

    // 3. Record election in evidence_item
    db.run(
        `INSERT INTO evidence_item (project, turn_id, seq, kind, payload, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            'proj-pin-test',
            'turn-pin-1',
            1,
            'election',
            JSON.stringify({
                capability: 'codegraph',
                branch: 'eso-native',
                provider_id: 'eso-cg',
                guarantee: 'G-FULL',
                pinned: true,
                reason: 'Elected via DB pin',
            }),
            new Date().toISOString(),
        ]
    );

    // 4. queryTurnProviderAudit reads from evidence_item
    const auditRes = queryTurnProviderAudit({
        project: 'proj-pin-test',
        turnId: 'turn-pin-1',
        db,
    });
    assert.equal(auditRes.records.length, 1);
    assert.equal(auditRes.records[0].capability, 'codegraph');
    assert.equal(auditRes.records[0].branch, 'eso-native');
    assert.equal(auditRes.records[0].provider_id, 'eso-cg');
});
