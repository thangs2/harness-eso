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

test('ESO-383: mid-turn fallback to none records the switch with the failure reason', () => {
    const election = {
        turn_id: 'turn-fallback-none',
        capability: 'codegraph_query',
        branch: 'external',
        provider_id: 'ext-cg',
        history: [{ branch: 'external', status: 'elected' }],
    };

    const res = handleMidTurnBranchFailure({
        currentElection: election,
        failureReason: 'Provider uninstalled mid-turn',
        branches: {}, // nothing left: the switch lands on none
    });

    assert.equal(res.branch, 'none');
    assert.equal(res.switched, true);
    assert.equal(res.guarantee, 'G-DEGRADED');
    assert.ok(res.switch_record, 'fallback to none must still record the switch');
    assert.equal(res.switch_record.from, 'external');
    assert.equal(res.switch_record.to, 'none');
    assert.equal(res.switch_record.reason, 'Provider uninstalled mid-turn');
    assert.equal(res.switch_record.silent, false);
    assert.equal(res.reason, 'Nhánh \'external\' gặp lỗi (Provider uninstalled mid-turn); hạ xuống none');
    assert.ok(
        res.history.some((h) => h.status === 'failed' && h.reason === 'Provider uninstalled mid-turn'),
        'failed branch must remain in history with its reason'
    );
});

async function withPg(fn) {
    const { createTestPgDb } = await import('./helpers/test-pg-db.mjs');
    const pg = await createTestPgDb();
    try {
        return await fn(pg);
    } finally {
        await pg.cleanup();
    }
}

test('ESO-382: election reads capability_pin from DB store and queryTurnProviderAudit reads evidence_item', async () => {
    await withPg(async (pg) => {
        const {
            electCapabilityProvider,
            setCapabilityPin,
            queryTurnProviderAudit,
        } = await import('../eso/adapters/src/election.mjs');
        const { ensureEvidenceSchema } = await import('../eso/adapters/src/host-bridge.mjs');

        const db = pg.db;
        await ensureEvidenceSchema(db);

        // 1. Set pin in DB
        await setCapabilityPin({
            project: 'proj-pin-test',
            capabilityKind: 'codegraph',
            targetBranch: 'eso-native',
            db,
        });

        // 2. Election without pins argument reads from DB
        const election = await electCapabilityProvider({
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

        // 3. Record election in evidence_item. The canonical schema has a foreign key to the
        // turn row, so the turn exists first — the audit still reads the item, not the turn.
        await db.run(
            `INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload)
             VALUES (?, ?, ?, 'operator', 'FULL', 'sufficient', 'do', 'verified', '2.0.0', '{}')`,
            ['proj-pin-test', 'turn-pin-1', '2026-11-05T00:00:00.000Z']
        );
        await db.run(
            `INSERT INTO evidence_item (project, turn_id, seq, kind, payload)
             VALUES (?, ?, ?, ?, ?)`,
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
            ]
        );

        // 4. queryTurnProviderAudit reads from evidence_item
        const auditRes = await queryTurnProviderAudit({
            project: 'proj-pin-test',
            turnId: 'turn-pin-1',
            db,
        });
        assert.equal(auditRes.records.length, 1);
        assert.equal(auditRes.records[0].capability, 'codegraph');
        assert.equal(auditRes.records[0].branch, 'eso-native');
        assert.equal(auditRes.records[0].provider_id, 'eso-cg');
    });
});

test('ESO-382: pin written in one process drives election after a restart (fresh DB handle, no pins argument)', async () => {
    await withPg(async (pg) => {
        const { electCapabilityProvider, setCapabilityPin } = await import('../eso/adapters/src/election.mjs');

        // Process 1: operator pins the capability, then the connection goes away.
        let db = pg.db;
        await setCapabilityPin({ project: 'proj-restart', capabilityKind: 'codegraph', targetBranch: 'eso-native', db });
        await db.close();

        // Process 2: brand-new handle on the same schema; no pins passed in memory.
        db = await pg.reconnect();
        const branches = {
            'host-native': { available: true, provider_id: 'cursor-cg' },
            'eso-native': { available: true, provider_id: 'eso-cg' },
        };
        const election = await electCapabilityProvider({
            project: 'proj-restart',
            turnId: 'turn-restart-1',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(election.branch, 'eso-native', 'pin must survive the restart');
        assert.equal(election.pinned, true);

        // Control: the same reopened store does not pin another project.
        const unpinned = await electCapabilityProvider({
            project: 'proj-other',
            turnId: 'turn-restart-2',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(unpinned.branch, 'host-native');
        assert.notEqual(unpinned.pinned, true);
        await db.close();
    });
});

test('ESO-382: turn audit reads elections written by the evidence recorder into the canonical evidence store', async () => {
    await withPg(async (pg) => {
        const { initEvidenceSchema } = await import('../eso/evidence/src/schema.mjs');
        const { recordTurn } = await import('../eso/evidence/src/recorder.mjs');
        const { electCapabilityProvider, queryTurnProviderAudit } = await import('../eso/adapters/src/election.mjs');

        const db = pg.db;
        await initEvidenceSchema(db);

        const election = await electCapabilityProvider({
            project: 'proj-evidence',
            turnId: 'turn-evidence-1',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches: { 'host-native': { available: true, provider_id: 'cursor-cg' } },
        });

        await recordTurn(
            db,
            {
                project: 'proj-evidence',
                turn_id: 'turn-evidence-1',
                at: '2026-11-05T00:00:00.000Z',
                resolved: [election],
            },
            { isRuntime: true }
        );

        const audit = await queryTurnProviderAudit({ project: 'proj-evidence', turnId: 'turn-evidence-1', db });
        assert.equal(audit.records.length, 1, 'audit must read the evidence_item written by the recorder');
        assert.equal(audit.records[0].capability, 'codegraph');
        assert.equal(audit.records[0].branch, 'host-native');
        assert.equal(audit.records[0].provider_id, 'cursor-cg');
        assert.equal(audit.records[0].reason, election.reason);
        assert.equal(audit.records[0].recorded_at, '2026-11-05T00:00:00.000Z');
    });
});
