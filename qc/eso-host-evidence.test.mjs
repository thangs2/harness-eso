import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureEvidenceSchema, readTurnEvidence, listTurnEvidence } from '../eso/adapters/src/host-bridge.mjs';
import { recordTurn, readTurn } from '../eso/evidence/src/recorder.mjs';
import { queryTurnProviderAudit } from '../eso/adapters/src/election.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/**
 * ESO-382 (D-93): one evidence store, two writers.
 *
 * `host-bridge.ensureEvidenceSchema` and `eso/evidence/src/schema.mjs` both describe the
 * evidence tables. The adapter-local DDL used to add a NOT NULL `at` column to `evidence_item`
 * that the canonical recorder never writes, so `recordTurn` died on any adapter-created store.
 * These tests pin the canonical shape and prove the canonical writer/reader work on a store the
 * host bridge created — on PostgreSQL, with no SQLite file or `:memory:` handle anywhere.
 */

const ELECTION = {
    capability: 'codegraph_query',
    branch: 'eso-native',
    provider_id: 'eso-cg',
    guarantee: 'G-FULL',
    pinned: true,
    reason: 'Operator pin survived restart',
    history: [{ branch: 'eso-native', status: 'elected' }],
};

async function withPg(fn) {
    const pg = await createTestPgDb();
    try {
        return await fn(pg);
    } finally {
        await pg.cleanup();
    }
}

test('ESO-382: ensureEvidenceSchema creates evidence_item in the canonical shape (turn carries the only timestamp)', async () => {
    await withPg(async (pg) => {
        await ensureEvidenceSchema(pg.db);
        const columns = (await pg.db.all(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'evidence_item'`
        )).map((c) => c.column_name);

        assert.deepEqual(
            [...columns].sort(),
            ['kind', 'payload', 'project', 'seq', 'turn_id'],
            'evidence_item must match eso/evidence/src/schema.mjs, which has no per-item `at`'
        );
    });
});

test('ESO-382: canonical recordTurn writes items on an adapter-created store and both readers agree', async () => {
    await withPg(async (pg) => {
        // Store created only by the host bridge — nothing from eso/evidence runs before the write.
        let db = pg.db;
        await ensureEvidenceSchema(db);

        await recordTurn(
            db,
            {
                project: 'proj-host-evidence',
                turn_id: 'turn-host-1',
                at: '2026-11-05T01:02:03.000Z',
                resolved: [ELECTION],
                items: [{ kind: 'claim', payload: { claim: 'pin respected' } }],
            },
            { isRuntime: true }
        );

        const turn = await readTurn(db, { project: 'proj-host-evidence', turn_id: 'turn-host-1' });
        assert.equal(turn.at, '2026-11-05T01:02:03.000Z');
        assert.equal(turn.resolved.length, 1);
        assert.equal(turn.resolved[0].capability, 'codegraph_query');

        // The host-bridge reader must see the same row the canonical recorder wrote.
        const viaBridge = await readTurnEvidence({ db, project: 'proj-host-evidence', turnId: 'turn-host-1' });
        assert.equal(viaBridge.turn_id, 'turn-host-1');
        assert.equal(viaBridge.at, '2026-11-05T01:02:03.000Z');

        const listed = await listTurnEvidence({ db, project: 'proj-host-evidence' });
        assert.equal(listed.length, 1);
        await db.close();

        // Restart: a fresh handle must still read both the turn and the election item.
        db = await pg.reconnect();
        await ensureEvidenceSchema(db);
        const audit = await queryTurnProviderAudit({ project: 'proj-host-evidence', turnId: 'turn-host-1', db });
        assert.equal(audit.records.length, 1);
        assert.equal(audit.records[0].capability, 'codegraph_query');
        assert.equal(audit.records[0].branch, 'eso-native');
        assert.equal(
            audit.records[0].recorded_at,
            '2026-11-05T01:02:03.000Z',
            'without a per-item timestamp the audit must use the turn time, not null'
        );
        await db.close();
    });
});
