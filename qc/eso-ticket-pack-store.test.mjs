import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketPackStore, computeHash } from '../eso/core/src/ticket-pack.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

const pack1 = { ac: ['AC-1'], scope: ['src/a.ts'], verify: 'bun test', forbidden: ['src/forbidden/**'] };
const pack2 = { ac: ['AC-1', 'AC-2'], scope: ['src/a.ts', 'src/b.ts'], verify: 'bun test', forbidden: ['src/forbidden/**'] };

test('ESO-389 / B11: In-memory ticket_pack store retains 2 packs history (append-only)', async () => {
    const store = await createTicketPackStore();
    const r1 = await store.appendPack({ project: 'p1', source: 'jira', ticket_key: 'ESO-100', fetched_at: '2026-11-04T10:00:00.000Z', pack: pack1 });
    const r2 = await store.appendPack({ project: 'p1', source: 'jira', ticket_key: 'ESO-100', fetched_at: '2026-11-04T11:00:00.000Z', pack: pack2 });
    assert.notEqual(r1.content_hash, r2.content_hash);
    const history = await store.getPacks({ project: 'p1', ticket_key: 'ESO-100' });
    assert.equal(history.length, 2);
    assert.equal(history[0].content_hash, r1.content_hash);
    assert.equal(history[1].content_hash, r2.content_hash);
    const latest = await store.getLatestPack({ project: 'p1', ticket_key: 'ESO-100' });
    assert.equal(latest.content_hash, r2.content_hash);
});

test('ESO-389 / B11: Tamper rejection at append and verification', async () => {
    const store = await createTicketPackStore();
    const pack = { ac: ['AC-1'], scope: ['src/a.ts'], verify: 'bun test', forbidden: [] };
    await assert.rejects(
        () => store.appendPack({ project: 'p1', source: 'jira', ticket_key: 'ESO-101', fetched_at: '2026-11-04T10:00:00.000Z', pack, content_hash: 'tampered-hash-12345' }),
        (err) => err.code === 'PACK_TAMPERED'
    );
    const valid = await store.appendPack({ project: 'p1', source: 'jira', ticket_key: 'ESO-101', fetched_at: '2026-11-04T10:00:00.000Z', pack });
    assert.equal(store.verifyIntegrity(valid).valid, true);
    assert.throws(() => store.verifyIntegrity({ ...valid, pack: { ...valid.pack, scope: ['src/evil.ts'] } }), (err) => err.code === 'PACK_TAMPERED');
});

test('ESO-389 / B11: PostgreSQL-backed ticket_pack store with dual engine and source none', async () => {
    const pg = await createTestPgDb();
    const store = await createTicketPackStore({ db: pg.db });
    try {
        const tried = [{ source: 'jira', result: 'no_ticket' }, { source: 'notion', result: 'not_configured' }];
        const rNone = await store.appendPack({ project: 'p2', source: 'none', ticket_key: null, tried, fetched_at: '2026-11-04T12:00:00.000Z', pack: { missing: ['ticket-source'] } });
        assert.equal(rNone.ticket_key, null);
        assert.equal(rNone.source, 'none');
        await store.appendPack({ project: 'p2', source: 'jira', ticket_key: 'ESO-200', fetched_at: '2026-11-04T12:05:00.000Z', pack: { version: 1, ac: ['A'] } });
        await store.appendPack({ project: 'p2', source: 'jira', ticket_key: 'ESO-200', fetched_at: '2026-11-04T12:10:00.000Z', pack: { version: 2, ac: ['A', 'B'] } });
        const packs = await store.getPacks({ project: 'p2' });
        assert.equal(packs.length, 3);
        const latest = await store.getLatestPack({ project: 'p2', ticket_key: 'ESO-200' });
        assert.equal(latest.pack.version, 2);
        await assert.rejects(() => pg.db.run("UPDATE ticket_pack SET source = 'tampered' WHERE project = 'p2'"), /append-only/i);
        await assert.rejects(() => pg.db.run("DELETE FROM ticket_pack WHERE project = 'p2'"), /append-only/i);
    } finally {
        await pg.cleanup();
    }
});

test('ESO-389 / B11: Reading tampered row via getPacks throws PACK_TAMPERED', async () => {
    const pg = await createTestPgDb();
    const store = await createTicketPackStore({ db: pg.db });
    try {
        const rec = await store.appendPack({ project: 'p3', source: 'jira', ticket_key: 'ESO-300', fetched_at: '2026-11-04T13:00:00.000Z', pack: { ac: ['X'] } });
        await pg.db.run('DROP TRIGGER IF EXISTS trg_ticket_pack_no_change ON ticket_pack');
        await pg.db.run('UPDATE ticket_pack SET content_hash = ? WHERE project = ? AND fetched_at = ?', ['bad-hash', 'p3', rec.fetched_at]);
        await assert.rejects(() => store.getPacks({ project: 'p3' }), (err) => err.code === 'PACK_TAMPERED');
    } finally {
        await pg.cleanup();
    }
});
