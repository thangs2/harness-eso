import assert from 'node:assert/strict';
import test from 'node:test';

import { checkIsolationFiles, checkIsolation } from '../packages/harness-eso-core/src/isolation-check.mjs';

const tables = ['orders', 'invoices'];

test('a query on a project table without a project filter is reported', () => {
    const out = checkIsolation({ content: 'SELECT id FROM orders WHERE status = $1', scopedTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].kind, 'query-without-caller');
    assert.equal(out.findings[0].table, 'orders');
});

test('a project predicate satisfies the check, including in a join', () => {
    const withWhere = checkIsolation({ content: 'SELECT * FROM orders WHERE caller_id = $1', scopedTables: tables });
    assert.deepEqual(withWhere.findings, []);

    const inJoin = checkIsolation(
        { content: 'SELECT * FROM orders o JOIN invoices i ON i.order_id = o.id WHERE o.caller_id = $1', scopedTables: tables },
        {},
    );
    assert.deepEqual(inJoin.findings, [], 'one project predicate covers the statement, conservatively');
});

test('an insert without a project column is reported separately', () => {
    const out = checkIsolation({ content: 'INSERT INTO invoices (id, total) VALUES ($1, $2)', scopedTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].kind, 'insert-without-caller');

    const ok = checkIsolation({ content: 'INSERT INTO invoices (id, caller_id, total) VALUES ($1, $2, $3)', scopedTables: tables });
    assert.deepEqual(ok.findings, []);
});

test('tables the caller did not declare are not guessed at', () => {
    const out = checkIsolation({ content: 'SELECT * FROM audit_log', scopedTables: tables });
    assert.deepEqual(out.findings, [], 'scope is declared, not inferred from the name');
    assert.deepEqual(checkIsolation({ content: 'SELECT * FROM orders', scopedTables: [] }).findings, []);
});

test('an explicit global marker is a decision, not a finding', () => {
    const out = checkIsolation({ content: 'SELECT * FROM orders /* isolation:global */', scopedTables: tables });
    assert.deepEqual(out.findings, []);
});

test('schema-qualified names match by base table and keep the written name', () => {
    const out = checkIsolation({ content: 'DELETE FROM public.orders', scopedTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].table, 'public.orders');
});

test('one bad statement among several is reported once', () => {
    const out = checkIsolation({
        content: 'UPDATE orders SET status = $1 WHERE caller_id = $2; DELETE FROM invoices',
        scopedTables: tables,
    });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].table, 'invoices');
});

test('file-level results keep the file name on every finding', () => {
    const out = checkIsolationFiles(
        [
            { file: 'migrations/001.sql', content: 'SELECT * FROM orders' },
            { file: 'queries/ok.sql', content: 'SELECT * FROM orders WHERE caller_id = $1' },
        ],
        { scopedTables: tables },
    );
    assert.equal(out.files, 2);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'migrations/001.sql');
});
