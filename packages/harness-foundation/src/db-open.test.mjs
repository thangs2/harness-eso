import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from './db-open.mjs';

test('openDb :memory: runs pragma and query', () => {
    const db = openDb(':memory:');
    const row = db.get('SELECT 1 AS n');
    assert.equal(row?.n, 1);
    db.close();
});

test('openDb tx commits', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    db.tx(() => {
        db.run('INSERT INTO t (v) VALUES (?)', ['ok']);
    });
    assert.equal(db.get('SELECT COUNT(*) AS c FROM t')?.c, 1);
    db.close();
});
