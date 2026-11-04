import test from 'node:test';
import assert from 'node:assert/strict';
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
