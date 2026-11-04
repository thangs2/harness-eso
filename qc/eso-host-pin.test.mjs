import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import {
    setCapabilityPin,
    loadCapabilityPins,
    recordTurnProviderAudit,
    queryTurnProviderAudit,
    queryBatchProviderAudit,
} from '../eso/adapters/src/index.mjs';

test('ESO-382 / B4: Capability pin persists across restart in SQLite DB', () => {
    const db = createDbAdapter(':memory:');

    // 1. Operator pins codegraph_query to eso-native
    const pins = setCapabilityPin({
        project: 'p1',
        capabilityKind: 'codegraph_query',
        targetBranch: 'eso-native',
        actorRole: 'operator',
        db,
    });
    assert.equal(pins.codegraph_query, 'eso-native');

    // 2. Simulate restart by loading pins from DB directly
    const restoredPins = loadCapabilityPins({ project: 'p1', db });
    assert.equal(restoredPins.codegraph_query, 'eso-native');

    // 3. Agent is forbidden from mutating pin
    assert.throws(
        () => {
            setCapabilityPin({
                project: 'p1',
                capabilityKind: 'codegraph_query',
                targetBranch: 'external',
                actorRole: 'agent',
                db,
            });
        },
        (err) => err.code === 'FORBIDDEN_MUTATION'
    );

    // 4. Removing pin
    setCapabilityPin({
        project: 'p1',
        capabilityKind: 'codegraph_query',
        targetBranch: '',
        actorRole: 'operator',
        db,
    });
    const afterRemoval = loadCapabilityPins({ project: 'p1', db });
    assert.equal(afterRemoval.codegraph_query, undefined);
});

test('ESO-382 / B4: Turn provider audit reads from evidence store (DB)', () => {
    const db = createDbAdapter(':memory:');

    // 1. Record election audit into evidence store
    const turnId = 'turn-audit-123';
    recordTurnProviderAudit({
        project: 'p1',
        turnId,
        election: {
            capability: 'subagents',
            branch: 'host-native',
            provider_id: 'cursor-subagents',
            guarantee: 'G-FULL',
            reason: 'Elected host native',
            history: [{ branch: 'host-native', status: 'elected' }],
        },
        db,
    });

    recordTurnProviderAudit({
        project: 'p1',
        turnId,
        election: {
            capability: 'codegraph_query',
            branch: 'none',
            provider_id: null,
            guarantee: 'G-DEGRADED',
            reason: 'Fallback to none',
            history: [{ branch: 'none', status: 'fallback' }],
        },
        db,
    });

    // 2. Query turn audit without passing auditLog array - reads from DB
    const res = queryTurnProviderAudit({
        turnId,
        project: 'p1',
        db,
    });

    assert.equal(res.turn_id, turnId);
    assert.equal(res.records.length, 2);
    assert.equal(res.has_degraded, true);
    const subRecord = res.records.find((r) => r.capability === 'subagents');
    const cgRecord = res.records.find((r) => r.capability === 'codegraph_query');
    assert.ok(subRecord);
    assert.ok(cgRecord);
    assert.equal(cgRecord.branch, 'none');

    // 3. Batch query from DB
    const batch = queryBatchProviderAudit({
        turnIds: [turnId],
        project: 'p1',
        db,
    });
    assert.equal(batch.length, 2);
    assert.equal(batch[0].capability, 'codegraph_query'); // Stably sorted by capability
    assert.equal(batch[1].capability, 'subagents');
});
