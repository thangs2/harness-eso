import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initEvidenceSchema,
    OutboxBuffer,
    flushOutbox,
    readTurn,
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

test('SCN-EV-17 (D-20 & AC-EV-01-06): Outbox writes locally and flushes to evidence tables asynchronously without blocking turn', () => {
    const db = createDb();
    const outbox = new OutboxBuffer();
    const project = 'proj-outbox-e2e';

    // 1. Turn writes to outbox (synchronous, local, 0 DB calls on turn path - D-20)
    const enq1 = outbox.write({
        project,
        turn_id: 'turn-async-1',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
        resolved: [{ rule: 'LAW-1', elected: true }],
        files_used: [{ path: 'src/app.ts', hash: 'sha256:app', commit: 'c1', dirty: false }],
    });

    const enq2 = outbox.write({
        project,
        turn_id: 'turn-async-2',
        level: 'partial',
        mode: 'ask',
        basis: 'retrieved',
        resolved: [{ rule: 'LAW-2', elected: false }],
        files_used: [{ path: 'src/lib.ts', hash: 'sha256:lib', dirty: true }],
    });

    assert.equal(enq1.queued, true);
    assert.equal(enq2.queued, true);
    assert.equal(outbox.size(), 2);

    // 2. Off-path ingest flush
    const flushRes = flushOutbox(outbox, db, { batchSize: 10 });
    assert.equal(flushRes.shippedCount, 2);
    assert.equal(flushRes.failedCount, 0);
    assert.equal(outbox.size(), 0);

    // 3. Verify turns exist in DB
    const t1 = readTurn(db, { project, turn_id: 'turn-async-1' });
    assert.equal(t1.level, 'sufficient');
    assert.equal(t1.resolved.length, 1);

    const t2 = readTurn(db, { project, turn_id: 'turn-async-2' });
    assert.equal(t2.level, 'partial');
    assert.equal(t2.files_used[0].dirty, true);
});

test('SCN-EV-18 (AC-EV-01-06 & ED6): Duplicate batch replay through outbox is completely idempotent', () => {
    const db = createDb();
    const outbox = new OutboxBuffer();
    const project = 'proj-dup-outbox';

    const turnPayload = {
        project,
        turn_id: 'turn-dup-replay',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
        resolved: [{ rule: 'LAW-IMMUTABLE', elected: true }],
    };

    // First delivery through outbox
    outbox.write(turnPayload);
    flushOutbox(outbox, db);

    // Second delivery of same payload
    outbox.write(turnPayload);
    const secondFlush = flushOutbox(outbox, db);

    assert.equal(secondFlush.shippedCount, 1);
    assert.equal(outbox.size(), 0);

    // DB row count must remain exactly 1
    const count = db.get(`SELECT COUNT(*) as c FROM evidence_turn WHERE project = ? AND turn_id = ?`, [project, 'turn-dup-replay']);
    assert.equal(count.c, 1);
});

test('SCN-EV-19 (D-20 Resilience): Outbox preserves entries and recovers cleanly when DB recovers from failure', () => {
    const realDb = createDb();
    const outbox = new OutboxBuffer();
    const project = 'proj-resilience';

    outbox.write({
        project,
        turn_id: 'turn-resilient-1',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
    });

    // Simulated DB failure
    const brokenDb = {
        get: () => { throw new Error('Postgres 503 Service Unavailable'); },
        run: () => { throw new Error('Postgres 503 Service Unavailable'); },
        all: () => [],
    };

    const failedFlush = flushOutbox(outbox, brokenDb);
    assert.equal(failedFlush.shippedCount, 0);
    assert.equal(failedFlush.failedCount, 1);
    assert.equal(outbox.size(), 1, 'Entry must remain buffered during failure');

    // DB recovers
    const recoveryFlush = flushOutbox(outbox, realDb);
    assert.equal(recoveryFlush.shippedCount, 1);
    assert.equal(outbox.size(), 0);

    const verified = readTurn(realDb, { project, turn_id: 'turn-resilient-1' });
    assert.equal(verified.turn_id, 'turn-resilient-1');
});

test('SCN-EV-20 (AC-EV-01-07 & ED10): Ingested turn preserves FileUse hash and reports gone: true when file deleted', () => {
    const db = createDb();
    const outbox = new OutboxBuffer();
    const project = 'proj-outbox-dangling';

    outbox.write({
        project,
        turn_id: 'turn-outbox-df',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
        files_used: [
            { path: 'src/deleted.ts', hash: 'sha256:preserved', commit: 'commit-123', dirty: false },
        ],
    });

    flushOutbox(outbox, db);

    const mockFs = (p) => false; // file deleted
    const res = readTurn(db, {
        project,
        turn_id: 'turn-outbox-df',
        fsExists: mockFs,
    });

    assert.equal(res.files_used.length, 1);
    assert.equal(res.files_used[0].gone, true);
    assert.equal(res.files_used[0].content_hash, 'sha256:preserved');
    assert.equal(res.files_used[0].git_commit, 'commit-123');
});
