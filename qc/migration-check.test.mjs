import assert from 'node:assert/strict';
import test from 'node:test';

import { checkMigrationFiles, checkMigrationSafety } from '../packages/harness-eso-core/src/migration-check.mjs';

const kinds = (sql) => checkMigrationSafety({ content: sql }).findings.map((f) => f.kind);

test('destructive DDL is reported', () => {
    assert.deepEqual(kinds('DROP TABLE orders'), ['drop-table']);
    assert.deepEqual(kinds('ALTER TABLE orders DROP COLUMN status'), ['drop-column']);
    assert.deepEqual(kinds('ALTER TABLE orders RENAME COLUMN a TO b'), ['rename']);
    assert.deepEqual(kinds('ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2)'), ['type-change']);
    assert.deepEqual(kinds('ALTER TABLE orders ALTER COLUMN status SET NOT NULL'), ['set-not-null']);
});

test('a new NOT NULL column needs a default', () => {
    assert.deepEqual(kinds('ALTER TABLE orders ADD COLUMN region text NOT NULL'), ['add-not-null-without-default']);
    assert.deepEqual(kinds('ALTER TABLE orders ADD COLUMN region text NOT NULL DEFAULT \'eu\''), []);
    assert.deepEqual(kinds('ALTER TABLE orders ADD COLUMN region text'), []);
});

test('the approved marker records a reviewed exception', () => {
    assert.deepEqual(kinds('DROP COLUMN status /* breaking:approved — readers migrated in #123 */'), []);
});

test('harmless DDL stays silent', () => {
    assert.deepEqual(kinds('CREATE INDEX idx_orders_caller ON orders (caller_id)'), []);
    assert.deepEqual(kinds('ALTER TABLE orders DROP CONSTRAINT fk_old'), []);
    assert.deepEqual(kinds('DROP INDEX IF EXISTS idx_old'), []);
});

test('one statement is reported once per rule, and files keep their name', () => {
    const out = checkMigrationFiles([
        { file: 'migrations/001.sql', content: 'DROP TABLE orders' },
        { file: 'migrations/002.sql', content: 'ALTER TABLE orders ADD COLUMN region text' },
    ]);
    assert.equal(out.files, 2);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'migrations/001.sql');
});
