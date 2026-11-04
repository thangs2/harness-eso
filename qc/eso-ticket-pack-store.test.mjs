import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketPackStore, computeHash } from '../eso/core/src/ticket-pack.mjs';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';

test('ESO-389 / B11: In-memory ticket_pack store retains 2 packs history (append-only)', () => {
    const store = createTicketPackStore();

    const pack1 = {
        ac: ['AC-1'],
        scope: ['src/a.ts'],
        verify: 'bun test',
        forbidden: ['src/forbidden/**'],
    };

    const pack2 = {
        ac: ['AC-1', 'AC-2'],
        scope: ['src/a.ts', 'src/b.ts'],
        verify: 'bun test',
        forbidden: ['src/forbidden/**'],
    };

    const r1 = store.appendPack({
        project: 'p1',
        source: 'jira',
        ticket_key: 'ESO-100',
        fetched_at: '2026-11-04T10:00:00.000Z',
        pack: pack1,
    });

    const r2 = store.appendPack({
        project: 'p1',
        source: 'jira',
        ticket_key: 'ESO-100',
        fetched_at: '2026-11-04T11:00:00.000Z',
        pack: pack2,
    });

    assert.notEqual(r1.content_hash, r2.content_hash);

    const history = store.getPacks({ project: 'p1', ticket_key: 'ESO-100' });
    assert.equal(history.length, 2);
    assert.equal(history[0].content_hash, r1.content_hash);
    assert.equal(history[1].content_hash, r2.content_hash);

    const latest = store.getLatestPack({ project: 'p1', ticket_key: 'ESO-100' });
    assert.equal(latest.content_hash, r2.content_hash);
});

test('ESO-389 / B11: Tamper rejection at append and verification', () => {
    const store = createTicketPackStore();

    const pack = {
        ac: ['AC-1'],
        scope: ['src/a.ts'],
        verify: 'bun test',
        forbidden: [],
    };

    // 1. Appending with invalid content_hash rejected with PACK_TAMPERED
    assert.throws(
        () => {
            store.appendPack({
                project: 'p1',
                source: 'jira',
                ticket_key: 'ESO-101',
                fetched_at: '2026-11-04T10:00:00.000Z',
                pack,
                content_hash: 'tampered-hash-12345',
            });
        },
        (err) => {
            assert.equal(err.code, 'PACK_TAMPERED');
            return true;
        }
    );

    // 2. Append valid
    const valid = store.appendPack({
        project: 'p1',
        source: 'jira',
        ticket_key: 'ESO-101',
        fetched_at: '2026-11-04T10:00:00.000Z',
        pack,
    });

    const integrityOk = store.verifyIntegrity(valid);
    assert.equal(integrityOk.valid, true);

    // 3. Post-save tampering detected
    const tamperedRecord = {
        ...valid,
        pack: { ...valid.pack, scope: ['src/evil.ts'] },
    };

    assert.throws(
        () => {
            store.verifyIntegrity(tamperedRecord);
        },
        (err) => {
            assert.equal(err.code, 'PACK_TAMPERED');
            return true;
        }
    );
});

test('ESO-389 / B11: SQLite-backed ticket_pack store with dual engine and source none', () => {
    const db = createDbAdapter(':memory:');
    const store = createTicketPackStore({ db });

    // 1. Test source: 'none' with ticket_key: null and tried sources
    const tried = [
        { source: 'jira', result: 'no_ticket' },
        { source: 'notion', result: 'not_configured' },
    ];

    const rNone = store.appendPack({
        project: 'p2',
        source: 'none',
        ticket_key: null,
        tried,
        fetched_at: '2026-11-04T12:00:00.000Z',
        pack: { missing: ['ticket-source'] },
    });
    assert.equal(rNone.ticket_key, null);
    assert.equal(rNone.source, 'none');

    // 2. Add 2 packs for ESO-200 in SQLite
    store.appendPack({
        project: 'p2',
        source: 'jira',
        ticket_key: 'ESO-200',
        fetched_at: '2026-11-04T12:05:00.000Z',
        pack: { version: 1, ac: ['A'] },
    });

    store.appendPack({
        project: 'p2',
        source: 'jira',
        ticket_key: 'ESO-200',
        fetched_at: '2026-11-04T12:10:00.000Z',
        pack: { version: 2, ac: ['A', 'B'] },
    });

    const history = store.getPacks({ project: 'p2', ticket_key: 'ESO-200' });
    assert.equal(history.length, 2);
    assert.equal(history[0].pack.version, 1);
    assert.equal(history[1].pack.version, 2);

    // 3. Immutability: duplicate PK throws IMMUTABLE_RECORD
    assert.throws(
        () => {
            store.appendPack({
                project: 'p2',
                source: 'jira',
                ticket_key: 'ESO-200',
                fetched_at: '2026-11-04T12:05:00.000Z',
                pack: { version: 99 },
            });
        },
        (err) => {
            assert.equal(err.code, 'IMMUTABLE_RECORD');
            return true;
        }
    );

    // 4. Update / Delete blocked
    assert.throws(() => store.update(), (err) => err.code === 'FORBIDDEN_MUTATION');
    assert.throws(() => store.delete(), (err) => err.code === 'FORBIDDEN_MUTATION');
});
