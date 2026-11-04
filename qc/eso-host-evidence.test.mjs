import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import {
    ensureEvidenceSchema,
    readTurnEvidence,
    listTurnEvidence,
} from '../eso/adapters/src/host-bridge.mjs';
import { recordTurn, readTurn } from '../eso/evidence/src/recorder.mjs';
import { queryTurnProviderAudit } from '../eso/adapters/src/election.mjs';

/**
 * ESO-382: one evidence store, two writers.
 *
 * `host-bridge.ensureEvidenceSchema` and `eso/evidence/src/schema.mjs` both describe the
 * evidence tables. The adapter DDL used to add a NOT NULL `at` column to `evidence_item`
 * that the canonical recorder never writes, so `recordTurn` died with
 * SQLITE_CONSTRAINT_NOTNULL on any store the adapter had created. These tests pin the
 * canonical shape and prove the canonical writer/reader work on an adapter-created DB.
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

function withTempDb(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-host-evidence-'));
    const dbFile = path.join(dir, 'evidence.db');
    try {
        return fn(dbFile);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('ESO-382: ensureEvidenceSchema creates evidence_item in the canonical shape (turn carries the only timestamp)', () => {
    const db = createDbAdapter(':memory:');
    try {
        ensureEvidenceSchema(db);
        const columns = db.all('PRAGMA table_info(evidence_item)').map((c) => c.name);

        assert.deepEqual(
            [...columns].sort(),
            ['kind', 'payload', 'project', 'seq', 'turn_id'],
            'evidence_item must match eso/evidence/src/schema.mjs, which has no per-item `at`'
        );
    } finally {
        db.close();
    }
});

test('ESO-382: canonical recordTurn writes items on an adapter-created file DB and both readers agree', () => {
    withTempDb((dbFile) => {
        // Store created only by the adapter DDL — nothing from eso/evidence runs before the write.
        let db = createDbAdapter(dbFile);
        ensureEvidenceSchema(db);

        assert.doesNotThrow(() => {
            recordTurn(
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
        }, 'recordTurn must not hit a NOT NULL column the adapter invented');

        const turn = readTurn(db, { project: 'proj-host-evidence', turn_id: 'turn-host-1' });
        assert.equal(turn.at, '2026-11-05T01:02:03.000Z');
        assert.equal(turn.resolved.length, 1);
        assert.equal(turn.resolved[0].capability, 'codegraph_query');

        // The host-bridge reader must see the same row the canonical recorder wrote.
        const viaBridge = readTurnEvidence({ db, project: 'proj-host-evidence', turnId: 'turn-host-1' });
        assert.equal(viaBridge.turn_id, 'turn-host-1');
        assert.equal(viaBridge.at, '2026-11-05T01:02:03.000Z');

        const listed = listTurnEvidence({ db, project: 'proj-host-evidence' });
        assert.equal(listed.length, 1);
        db.close();

        // Restart: a fresh handle must still read both the turn and the election item.
        db = createDbAdapter(dbFile);
        ensureEvidenceSchema(db);
        const audit = queryTurnProviderAudit({ project: 'proj-host-evidence', turnId: 'turn-host-1', db });
        assert.equal(audit.records.length, 1);
        assert.equal(audit.records[0].capability, 'codegraph_query');
        assert.equal(audit.records[0].branch, 'eso-native');
        assert.equal(
            audit.records[0].recorded_at,
            '2026-11-05T01:02:03.000Z',
            'without a per-item timestamp the audit must use the turn time, not null'
        );
        db.close();
    });
});
