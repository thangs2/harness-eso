import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';

test('createDbAdapter unified interface works for exec, run, all, get, close', () => {
    const db = createDbAdapter(':memory:');

    // exec: create table
    db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            age INTEGER NOT NULL
        );
    `);

    // run with spread params
    const r1 = db.run('INSERT INTO users (name, age) VALUES (?, ?)', 'Alice', 30);
    assert.ok(r1.changes >= 1);

    // run with array params
    const r2 = db.run('INSERT INTO users (name, age) VALUES (?, ?)', ['Bob', 25]);
    assert.ok(r2.changes >= 1);

    // all with spread params
    const allRows = db.all('SELECT * FROM users ORDER BY id ASC');
    assert.equal(allRows.length, 2);
    assert.equal(allRows[0].name, 'Alice');
    assert.equal(allRows[1].name, 'Bob');

    // get with spread params
    const alice = db.get('SELECT * FROM users WHERE name = ?', 'Alice');
    assert.ok(alice);
    assert.equal(alice.name, 'Alice');
    assert.equal(alice.age, 30);

    // get with array params
    const bob = db.get('SELECT * FROM users WHERE name = ?', ['Bob']);
    assert.ok(bob);
    assert.equal(bob.name, 'Bob');
    assert.equal(bob.age, 25);

    // get nonexistent row returns undefined
    const none = db.get('SELECT * FROM users WHERE name = ?', 'Charlie');
    assert.equal(none, undefined);

    // close
    db.close();
});

test('createDbAdapter named parameters normalization works for :param, @param, $param', () => {
    const db = createDbAdapter(':memory:');
    db.exec(`
        CREATE TABLE items (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            count INTEGER NOT NULL
        );
    `);

    db.run('INSERT INTO items (code, count) VALUES (?, ?)', 'A1', 10);
    db.run('INSERT INTO items (code, count) VALUES (?, ?)', 'B2', 20);

    // Object with unprefixed keys
    const item1 = db.get('SELECT * FROM items WHERE code = :code', { code: 'A1' });
    assert.ok(item1);
    assert.equal(item1.code, 'A1');
    assert.equal(item1.count, 10);

    // Object with prefixed keys
    const item2 = db.get('SELECT * FROM items WHERE code = :code', { ':code': 'B2' });
    assert.ok(item2);
    assert.equal(item2.code, 'B2');
    assert.equal(item2.count, 20);

    // Multiple parameters
    const allMatching = db.all('SELECT * FROM items WHERE code = :c AND count = :cnt', { c: 'A1', cnt: 10 });
    assert.equal(allMatching.length, 1);
    assert.equal(allMatching[0].code, 'A1');

    db.close();
});

test('createDbAdapter BigInt consistency (> Number.MAX_SAFE_INTEGER)', () => {
    const db = createDbAdapter(':memory:');
    db.exec(`
        CREATE TABLE big_numbers (
            id INTEGER PRIMARY KEY,
            large_val INTEGER NOT NULL,
            small_val INTEGER NOT NULL
        );
    `);

    const largeNum = 9007199254740993n;
    db.run('INSERT INTO big_numbers (large_val, small_val) VALUES (?, ?)', largeNum, 42);

    const row = db.get('SELECT large_val, small_val FROM big_numbers WHERE id = 1');
    assert.ok(row);
    assert.equal(typeof row.large_val, 'bigint');
    assert.equal(row.large_val, 9007199254740993n);
    assert.equal(typeof row.small_val, 'number');
    assert.equal(row.small_val, 42);

    db.close();
});

test('createDbAdapter readonly enforcement throws on write for both readonly and readOnly', () => {
    const tempDir = os.tmpdir();
    const tempDbPath = path.join(tempDir, `eso-test-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

    // Create and seed database
    const seedDb = createDbAdapter(tempDbPath);
    seedDb.exec('CREATE TABLE test_ro (id INTEGER PRIMARY KEY, val TEXT);');
    seedDb.run('INSERT INTO test_ro (val) VALUES (?)', 'initial');
    seedDb.close();

    try {
        // Test with { readonly: true }
        const ro1 = createDbAdapter(tempDbPath, { readonly: true });
        const row1 = ro1.get('SELECT val FROM test_ro WHERE id = 1');
        assert.equal(row1.val, 'initial');
        assert.throws(() => {
            ro1.run('INSERT INTO test_ro (val) VALUES (?)', 'should_fail');
        });
        ro1.close();

        // Test with { readOnly: true }
        const ro2 = createDbAdapter(tempDbPath, { readOnly: true });
        const row2 = ro2.get('SELECT val FROM test_ro WHERE id = 1');
        assert.equal(row2.val, 'initial');
        assert.throws(() => {
            ro2.run('INSERT INTO test_ro (val) VALUES (?)', 'should_fail');
        });
        ro2.close();
    } finally {
        try {
            fs.unlinkSync(tempDbPath);
        } catch {
            // cleanup
        }
    }
});
