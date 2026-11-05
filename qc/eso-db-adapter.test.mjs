import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('createDbAdapter unified interface works for exec, run, all, get, close on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        // exec: create table
        await db.exec(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER NOT NULL
            );
        `);

        // run with spread params
        const r1 = await db.run('INSERT INTO users (name, age) VALUES (?, ?)', 'Alice', 30);
        assert.ok(r1.changes >= 1);

        // run with array params
        const r2 = await db.run('INSERT INTO users (name, age) VALUES (?, ?)', ['Bob', 25]);
        assert.ok(r2.changes >= 1);

        // all with spread params
        const allRows = await db.all('SELECT * FROM users ORDER BY id ASC');
        assert.equal(allRows.length, 2);
        assert.equal(allRows[0].name, 'Alice');
        assert.equal(allRows[1].name, 'Bob');

        // get with spread params
        const alice = await db.get('SELECT * FROM users WHERE name = ?', 'Alice');
        assert.ok(alice);
        assert.equal(alice.name, 'Alice');
        assert.equal(alice.age, 30);

        // get with array params
        const bob = await db.get('SELECT * FROM users WHERE name = ?', ['Bob']);
        assert.ok(bob);
        assert.equal(bob.name, 'Bob');
        assert.equal(bob.age, 25);

        // get nonexistent row returns undefined
        const none = await db.get('SELECT * FROM users WHERE name = ?', 'Charlie');
        assert.equal(none, undefined);
    } finally {
        await pg.cleanup();
    }
});

test('createDbAdapter named parameters normalization works for :param, @param, $param', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        await db.exec(`
            CREATE TABLE items (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL,
                count INTEGER NOT NULL
            );
        `);

        await db.run('INSERT INTO items (code, count) VALUES (?, ?)', 'A1', 10);
        await db.run('INSERT INTO items (code, count) VALUES (?, ?)', 'B2', 20);

        // Object with unprefixed keys
        const item1 = await db.get('SELECT * FROM items WHERE code = :code', { code: 'A1' });
        assert.ok(item1);
        assert.equal(item1.code, 'A1');
        assert.equal(item1.count, 10);

        // Object with prefixed keys
        const item2 = await db.get('SELECT * FROM items WHERE code = :code', { ':code': 'B2' });
        assert.ok(item2);
        assert.equal(item2.code, 'B2');
        assert.equal(item2.count, 20);

        // Multiple parameters
        const allMatching = await db.all('SELECT * FROM items WHERE code = :c AND count = :cnt', { c: 'A1', cnt: 10 });
        assert.equal(allMatching.length, 1);
        assert.equal(allMatching[0].code, 'A1');
    } finally {
        await pg.cleanup();
    }
});

test('createDbAdapter BigInt consistency (> Number.MAX_SAFE_INTEGER)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        await db.exec(`
            CREATE TABLE big_numbers (
                id SERIAL PRIMARY KEY,
                large_val BIGINT NOT NULL,
                small_val INTEGER NOT NULL
            );
        `);

        const largeNum = 9007199254740993n;
        await db.run('INSERT INTO big_numbers (large_val, small_val) VALUES (?, ?)', largeNum, 42);

        const row = await db.get('SELECT large_val, small_val FROM big_numbers WHERE id = 1');
        assert.ok(row);
        assert.equal(typeof row.large_val, 'bigint');
        assert.equal(row.large_val, 9007199254740993n);
        assert.equal(typeof row.small_val, 'number');
        assert.equal(row.small_val, 42);
    } finally {
        await pg.cleanup();
    }
});

test('createDbAdapter strictly rejects SQLite and enforces PostgreSQL connection URL (D-92 / D-93)', () => {
    assert.throws(() => {
        createDbAdapter(':memory:');
    }, /SQLite is prohibited/);

    assert.throws(() => {
        createDbAdapter('demo.sqlite');
    }, /SQLite is prohibited/);

    assert.throws(() => {
        createDbAdapter('/tmp/test.db');
    }, /SQLite is prohibited/);
});
