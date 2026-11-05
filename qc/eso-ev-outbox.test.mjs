import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initEvidenceSchema,
    OutboxBuffer,
    flushOutbox,
    readTurn,
} from '../eso/evidence/src/index.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/** D-93: PostgreSQL schema per test; the outbox itself stays local, the target store does not use SQLite. */
async function withDb(fn) {
    const pg = await createTestPgDb();
    try {
        await initEvidenceSchema(pg.db);
        return await fn(pg.db);
    } finally {
        await pg.cleanup();
    }
}

test('SCN-EV-17 (D-20 & AC-EV-01-06): Outbox writes locally and flushes to evidence tables asynchronously without blocking turn', async () => {
    await withDb(async (db) => {
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
        const flushRes = await flushOutbox(outbox, db, { batchSize: 10 });
        assert.equal(flushRes.shippedCount, 2);
        assert.equal(flushRes.failedCount, 0);
        assert.equal(outbox.size(), 0);

        // 3. Verify turns exist in DB
        const t1 = await readTurn(db, { project, turn_id: 'turn-async-1' });
        assert.equal(t1.level, 'sufficient');
        assert.equal(t1.resolved.length, 1);

        const t2 = await readTurn(db, { project, turn_id: 'turn-async-2' });
        assert.equal(t2.level, 'partial');
        assert.equal(t2.files_used[0].dirty, true);
    });
});

test('SCN-EV-18 (AC-EV-01-06 & ED6): Duplicate batch replay through outbox is completely idempotent', async () => {
    await withDb(async (db) => {
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
        await flushOutbox(outbox, db);

        // Second delivery of same payload
        outbox.write(turnPayload);
        const secondFlush = await flushOutbox(outbox, db);

        assert.equal(secondFlush.shippedCount, 1);
        assert.equal(outbox.size(), 0);

        // DB row count must remain exactly 1
        const count = await db.get(`SELECT COUNT(*) as c FROM evidence_turn WHERE project = ? AND turn_id = ?`, [project, 'turn-dup-replay']);
        assert.equal(Number(count.c), 1);
    });
});

test('SCN-EV-19 (D-20 Resilience): Outbox preserves entries and recovers cleanly when DB recovers from failure', async () => {
    await withDb(async (realDb) => {
        const outbox = new OutboxBuffer();
        const project = 'proj-resilience';

        outbox.write({
            project,
            turn_id: 'turn-resilient-1',
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
        });

        // Simulated DB failure: no exec/run, so schema init rejects before any insert.
        const brokenDb = {
            exec: async () => { throw new Error('Postgres 503 Service Unavailable'); },
            get: async () => { throw new Error('Postgres 503 Service Unavailable'); },
            run: async () => { throw new Error('Postgres 503 Service Unavailable'); },
            all: async () => [],
        };

        const failedFlush = await flushOutbox(outbox, brokenDb);
        assert.equal(failedFlush.shippedCount, 0);
        assert.equal(failedFlush.failedCount, 1);
        assert.equal(outbox.size(), 1, 'Entry must remain buffered during failure');

        // DB recovers
        const recoveryFlush = await flushOutbox(outbox, realDb);
        assert.equal(recoveryFlush.shippedCount, 1);
        assert.equal(outbox.size(), 0);

        const verified = await readTurn(realDb, { project, turn_id: 'turn-resilient-1' });
        assert.equal(verified.turn_id, 'turn-resilient-1');
    });
});

test('SCN-EV-20 (AC-EV-01-07 & ED10): Ingested turn preserves FileUse hash and reports gone: true when file deleted', async () => {
    await withDb(async (db) => {
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

        await flushOutbox(outbox, db);

        const mockFs = (p) => false; // file deleted
        const res = await readTurn(db, {
            project,
            turn_id: 'turn-outbox-df',
            fsExists: mockFs,
        });

        assert.equal(res.files_used.length, 1);
        assert.equal(res.files_used[0].gone, true);
        assert.equal(res.files_used[0].content_hash, 'sha256:preserved');
        assert.equal(res.files_used[0].git_commit, 'commit-123');
    });
});
