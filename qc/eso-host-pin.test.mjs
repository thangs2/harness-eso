import test from 'node:test';
import assert from 'node:assert/strict';

import { initEvidenceSchema } from '../eso/evidence/src/schema.mjs';
import { recordTurn } from '../eso/evidence/src/recorder.mjs';
import {
    electCapabilityProvider,
    setCapabilityPin,
    loadCapabilityPins,
    queryTurnProviderAudit,
} from '../eso/adapters/src/index.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/**
 * ESO-382 (D-93): pins and turn audit must survive a process restart.
 *
 * The store is PostgreSQL. "Restart" is a fresh adapter on the same isolated schema: the pin and
 * the evidence rows must come from the database, not from an in-process cache or a `:memory:`
 * handle that never honoured the claim.
 */

async function withPg(fn) {
    const pg = await createTestPgDb();
    try {
        return await fn(pg);
    } finally {
        await pg.cleanup();
    }
}

test('ESO-382 / SCN-HOST-12: capability pin persists across a real restart and drives election', async () => {
    await withPg(async (pg) => {
        const branches = {
            'host-native': { available: true, provider_id: 'cursor-cg' },
            'eso-native': { available: true, provider_id: 'eso-cg' },
        };

        // 1. Operator pins codegraph to eso-native, then the process/handle goes away.
        let db = pg.db;
        const pins = await setCapabilityPin({
            project: 'p1',
            capabilityKind: 'codegraph',
            targetBranch: 'eso-native',
            actorRole: 'operator',
            db,
        });
        assert.equal(pins.codegraph, 'eso-native');
        await db.close();

        // 2. Fresh handle on the same schema: the pin must come from the database, not memory.
        db = await pg.reconnect();
        assert.deepEqual(await loadCapabilityPins({ project: 'p1', db }), { codegraph: 'eso-native' });

        const election = await electCapabilityProvider({
            project: 'p1',
            turnId: 'turn-restart-1',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(election.branch, 'eso-native', 'pin must beat branch order after restart');
        assert.equal(election.pinned, true);

        // The pin is scoped to its project, not to the whole store.
        const otherProject = await electCapabilityProvider({
            project: 'p2',
            turnId: 'turn-restart-2',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(otherProject.branch, 'host-native');
        assert.notEqual(otherProject.pinned, true);

        // 3. RBAC still applies on the reopened store: an agent cannot mutate the pin.
        await assert.rejects(
            () => setCapabilityPin({
                project: 'p1',
                capabilityKind: 'codegraph',
                targetBranch: 'external',
                actorRole: 'agent',
                db,
            }),
            (err) => err.code === 'FORBIDDEN_MUTATION'
        );

        // 4. Empty pin removes it, and branch order takes over again.
        await setCapabilityPin({
            project: 'p1',
            capabilityKind: 'codegraph',
            targetBranch: '',
            actorRole: 'operator',
            db,
        });
        assert.equal((await loadCapabilityPins({ project: 'p1', db })).codegraph, undefined);

        const afterRemoval = await electCapabilityProvider({
            project: 'p1',
            turnId: 'turn-restart-3',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(afterRemoval.branch, 'host-native');
        assert.notEqual(afterRemoval.pinned, true);
        await db.close();
    });
});

test('ESO-382 / B4: turn provider audit reads elections from the canonical evidence store after a restart', async () => {
    await withPg(async (pg) => {
        const turnAt = '2026-11-05T02:00:00.000Z';
        const turnId = 'turn-audit-123';

        // 1. Canonical evidence store; elections are written by the canonical recorder.
        let db = pg.db;
        await initEvidenceSchema(db);
        await recordTurn(
            db,
            {
                project: 'p1',
                turn_id: turnId,
                at: turnAt,
                resolved: [
                    {
                        capability: 'subagents',
                        branch: 'host-native',
                        provider_id: 'cursor-subagents',
                        guarantee: 'G-FULL',
                        reason: 'Elected host native',
                        history: [{ branch: 'host-native', status: 'elected' }],
                    },
                    {
                        capability: 'codegraph_query',
                        branch: 'none',
                        provider_id: null,
                        guarantee: 'G-DEGRADED',
                        reason: 'Fallback to none',
                        history: [{ branch: 'none', status: 'fallback' }],
                    },
                ],
            },
            { isRuntime: true }
        );

        // 2. Audit reads the evidence items, not a separate audit table.
        const res = await queryTurnProviderAudit({ turnId, project: 'p1', db });
        assert.equal(res.turn_id, turnId);
        assert.equal(res.records.length, 2);
        assert.equal(res.has_degraded, true);
        const subRecord = res.records.find((r) => r.capability === 'subagents');
        const cgRecord = res.records.find((r) => r.capability === 'codegraph_query');
        assert.ok(subRecord);
        assert.ok(cgRecord);
        assert.equal(cgRecord.branch, 'none');
        assert.equal(cgRecord.reason, 'Fallback to none');
        // evidence_item has no timestamp of its own; the turn time must be used.
        assert.equal(subRecord.recorded_at, turnAt);
        assert.equal(cgRecord.recorded_at, turnAt);
        await db.close();

        // 3. Restart: a fresh handle must produce the same audit.
        db = await pg.reconnect();
        const afterRestart = await queryTurnProviderAudit({ turnId, project: 'p1', db });
        assert.deepEqual(afterRestart.records, res.records);
        assert.equal(afterRestart.has_degraded, true);
        await db.close();
    });
});
