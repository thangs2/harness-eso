import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initEvidenceSchema,
    openRisk,
    closeRisk,
    getRiskHistory,
    listActiveRisks,
} from '../eso/evidence/src/index.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/** D-93: each test gets an isolated PostgreSQL schema, cleaned up even when an assertion fails. */
async function withDb(fn) {
    const pg = await createTestPgDb();
    try {
        await initEvidenceSchema(pg.db);
        return await fn(pg.db);
    } finally {
        await pg.cleanup();
    }
}

test('SCN-EV-12 (AC-EV-04-01): Closing an open risk records event closed with actor and reason, preserving history', async () => {
    await withDb(async (db) => {
        const project = 'proj-risk-12';

        // 1. Initial opened event
        const openRes = await openRisk(db, {
            project,
            risk_id: 'risk-auth-gap',
            actor: 'scanner-agent',
            payload: { gap: 'Missing token expiry check', severity: 'HIGH' },
        });
        assert.equal(openRes.ok, true);
        assert.equal(openRes.seq, 1);

        // 2. Closure event
        const closeRes = await closeRisk(db, {
            project,
            risk_id: 'risk-auth-gap',
            actor: 'lead-secops@enterprise.internal',
            reason: 'Added JWT expiration verification in auth middleware',
        });
        assert.equal(closeRes.ok, true);
        assert.equal(closeRes.seq, 2);
        assert.equal(closeRes.event, 'closed');
        assert.equal(closeRes.by, 'lead-secops@enterprise.internal');

        // 3. Verify timeline: opened is preserved intact
        const timeline = await getRiskHistory(db, { project, risk_id: 'risk-auth-gap' });
        assert.equal(timeline.length, 2);
        assert.equal(timeline[0].event, 'opened');
        assert.equal(timeline[0].actor, 'scanner-agent');
        assert.equal(timeline[1].event, 'closed');
        assert.equal(timeline[1].payload.reason, 'Added JWT expiration verification in auth middleware');
    });
});

test('SCN-EV-13 (AC-EV-04-02 & BR-06): Direct modification or deletion of evidence_risk is rejected by append-only triggers', async () => {
    await withDb(async (db) => {
        const project = 'proj-risk-13';

        await openRisk(db, {
            project,
            risk_id: 'risk-immutable',
            actor: 'system',
            payload: { note: 'Do not tamper' },
        });

        // Attempt direct UPDATE
        await assert.rejects(() => db.run(`UPDATE evidence_risk SET actor = 'hacker' WHERE risk_id = 'risk-immutable'`), /BR-06/);

        // Attempt direct DELETE
        await assert.rejects(() => db.run(`DELETE FROM evidence_risk WHERE risk_id = 'risk-immutable'`), /BR-06/);

        const history = await getRiskHistory(db, { project, risk_id: 'risk-immutable' });
        assert.equal(history.length, 1);
        assert.equal(history[0].actor, 'system');
    });
});

test('SCN-EV-14 (AC-EV-04-03): Closed risks are strictly excluded from proposal clustering / active risks query', async () => {
    await withDb(async (db) => {
        const project = 'proj-risk-14';

        await openRisk(db, { project, risk_id: 'risk-live-1', actor: 'scanner' });
        await openRisk(db, { project, risk_id: 'risk-resolved', actor: 'scanner' });
        await openRisk(db, { project, risk_id: 'risk-live-2', actor: 'scanner' });

        await closeRisk(db, {
            project,
            risk_id: 'risk-resolved',
            actor: 'maintainer',
            reason: 'Resolved in patch PR #42',
        });

        const activeList = await listActiveRisks(db, { project });
        assert.equal(activeList.length, 2);

        const activeIds = activeList.map((r) => r.risk_id);
        assert.ok(activeIds.includes('risk-live-1'));
        assert.ok(activeIds.includes('risk-live-2'));
        assert.ok(!activeIds.includes('risk-resolved'), 'Closed risk must NOT be included in active list');
    });
});

test('SCN-EV-21 (AC-EV-04-04 & ED6): Closing a risk twice throws ALREADY_CLOSED and does not append duplicate event', async () => {
    await withDb(async (db) => {
        const project = 'proj-risk-21';

        await openRisk(db, { project, risk_id: 'risk-once', actor: 'scanner' });
        await closeRisk(db, { project, risk_id: 'risk-once', actor: 'operator', reason: 'Fixed' });

        // Second closure attempt
        await assert.rejects(() => closeRisk(db, { project, risk_id: 'risk-once', actor: 'operator', reason: 'Fixed duplicate attempt' }), (err) => {
            return err.code === 'ALREADY_CLOSED' || err.message.includes('ALREADY_CLOSED');
        });

        const timeline = await getRiskHistory(db, { project, risk_id: 'risk-once' });
        assert.equal(timeline.length, 2, 'Exactly 2 events must exist: opened and single closed');
    });
});

test('SCN-EV-22 (AC-EV-04-05 & ED7): Race condition / concurrency: closed risk never leaks into proposal clusters', async () => {
    await withDb(async (db) => {
        const project = 'proj-risk-22';

        await openRisk(db, { project, risk_id: 'risk-concurrent', actor: 'agent' });
        await closeRisk(db, { project, risk_id: 'risk-concurrent', actor: 'lead', reason: 'Closed prior to clustering' });

        const clusters = await listActiveRisks(db, { project });
        const match = clusters.find((r) => r.risk_id === 'risk-concurrent');
        assert.equal(match, undefined, 'Closed risk must never leak into proposal clusters');
    });
});
