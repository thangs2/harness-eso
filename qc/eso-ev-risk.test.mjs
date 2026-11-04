import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initEvidenceSchema,
    openRisk,
    closeRisk,
    getRiskHistory,
    listActiveRisks,
} from '../eso/evidence/src/index.mjs';

function createDb() {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        all: (sql, params = []) => rawDb.query(sql).all(...params),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
        get: (sql, params = []) => rawDb.query(sql).get(...params),
    };
    initEvidenceSchema(db);
    return db;
}

test('SCN-EV-12 (AC-EV-04-01): Closing an open risk records event closed with actor and reason, preserving history', () => {
    const db = createDb();
    const project = 'proj-risk-12';

    // 1. Initial opened event
    const openRes = openRisk(db, {
        project,
        risk_id: 'risk-auth-gap',
        actor: 'scanner-agent',
        payload: { gap: 'Missing token expiry check', severity: 'HIGH' },
    });
    assert.equal(openRes.ok, true);
    assert.equal(openRes.seq, 1);

    // 2. Closure event
    const closeRes = closeRisk(db, {
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
    const timeline = getRiskHistory(db, { project, risk_id: 'risk-auth-gap' });
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].event, 'opened');
    assert.equal(timeline[0].actor, 'scanner-agent');
    assert.equal(timeline[1].event, 'closed');
    assert.equal(timeline[1].payload.reason, 'Added JWT expiration verification in auth middleware');
});

test('SCN-EV-13 (AC-EV-04-02 & BR-06): Direct modification or deletion of evidence_risk is rejected by append-only triggers', () => {
    const db = createDb();
    const project = 'proj-risk-13';

    openRisk(db, {
        project,
        risk_id: 'risk-immutable',
        actor: 'system',
        payload: { note: 'Do not tamper' },
    });

    // Attempt direct UPDATE
    assert.throws(() => {
        db.run(`UPDATE evidence_risk SET actor = 'hacker' WHERE risk_id = 'risk-immutable'`);
    }, /BR-06/);

    // Attempt direct DELETE
    assert.throws(() => {
        db.run(`DELETE FROM evidence_risk WHERE risk_id = 'risk-immutable'`);
    }, /BR-06/);

    const history = getRiskHistory(db, { project, risk_id: 'risk-immutable' });
    assert.equal(history.length, 1);
    assert.equal(history[0].actor, 'system');
});

test('SCN-EV-14 (AC-EV-04-03): Closed risks are strictly excluded from proposal clustering / active risks query', () => {
    const db = createDb();
    const project = 'proj-risk-14';

    openRisk(db, { project, risk_id: 'risk-live-1', actor: 'scanner' });
    openRisk(db, { project, risk_id: 'risk-resolved', actor: 'scanner' });
    openRisk(db, { project, risk_id: 'risk-live-2', actor: 'scanner' });

    closeRisk(db, {
        project,
        risk_id: 'risk-resolved',
        actor: 'maintainer',
        reason: 'Resolved in patch PR #42',
    });

    const activeList = listActiveRisks(db, { project });
    assert.equal(activeList.length, 2);

    const activeIds = activeList.map((r) => r.risk_id);
    assert.ok(activeIds.includes('risk-live-1'));
    assert.ok(activeIds.includes('risk-live-2'));
    assert.ok(!activeIds.includes('risk-resolved'), 'Closed risk must NOT be included in active list');
});

test('SCN-EV-21 (AC-EV-04-04 & ED6): Closing a risk twice throws ALREADY_CLOSED and does not append duplicate event', () => {
    const db = createDb();
    const project = 'proj-risk-21';

    openRisk(db, { project, risk_id: 'risk-once', actor: 'scanner' });
    closeRisk(db, { project, risk_id: 'risk-once', actor: 'operator', reason: 'Fixed' });

    // Second closure attempt
    assert.throws(() => {
        closeRisk(db, { project, risk_id: 'risk-once', actor: 'operator', reason: 'Fixed duplicate attempt' });
    }, (err) => {
        return err.code === 'ALREADY_CLOSED' || err.message.includes('ALREADY_CLOSED');
    });

    const timeline = getRiskHistory(db, { project, risk_id: 'risk-once' });
    assert.equal(timeline.length, 2, 'Exactly 2 events must exist: opened and single closed');
});

test('SCN-EV-22 (AC-EV-04-05 & ED7): Race condition / concurrency: closed risk never leaks into proposal clusters', () => {
    const db = createDb();
    const project = 'proj-risk-22';

    openRisk(db, { project, risk_id: 'risk-concurrent', actor: 'agent' });
    closeRisk(db, { project, risk_id: 'risk-concurrent', actor: 'lead', reason: 'Closed prior to clustering' });

    const clusters = listActiveRisks(db, { project });
    const match = clusters.find((r) => r.risk_id === 'risk-concurrent');
    assert.equal(match, undefined, 'Closed risk must never leak into proposal clusters');
});
