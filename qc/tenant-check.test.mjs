import assert from 'node:assert/strict';
import test from 'node:test';

import { checkTenantFiles, checkTenantIsolation } from '../packages/harness-eso-core/src/tenant-check.mjs';

const tables = ['orders', 'invoices'];

test('a query on a tenant table without a tenant filter is reported', () => {
    const out = checkTenantIsolation({ content: 'SELECT id FROM orders WHERE status = $1', tenantTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].kind, 'query-without-tenant');
    assert.equal(out.findings[0].table, 'orders');
});

test('a tenant predicate satisfies the check, including in a join', () => {
    const withWhere = checkTenantIsolation({ content: 'SELECT * FROM orders WHERE tenant_id = $1', tenantTables: tables });
    assert.deepEqual(withWhere.findings, []);

    const inJoin = checkTenantIsolation(
        { content: 'SELECT * FROM orders o JOIN invoices i ON i.order_id = o.id WHERE o.tenant_id = $1', tenantTables: tables },
        {},
    );
    assert.deepEqual(inJoin.findings, [], 'one tenant predicate covers the statement, conservatively');
});

test('an insert without a tenant column is reported separately', () => {
    const out = checkTenantIsolation({ content: 'INSERT INTO invoices (id, total) VALUES ($1, $2)', tenantTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].kind, 'insert-without-tenant');

    const ok = checkTenantIsolation({ content: 'INSERT INTO invoices (id, tenant_id, total) VALUES ($1, $2, $3)', tenantTables: tables });
    assert.deepEqual(ok.findings, []);
});

test('tables the caller did not declare are not guessed at', () => {
    const out = checkTenantIsolation({ content: 'SELECT * FROM audit_log', tenantTables: tables });
    assert.deepEqual(out.findings, [], 'scope is declared, not inferred from the name');
    assert.deepEqual(checkTenantIsolation({ content: 'SELECT * FROM orders', tenantTables: [] }).findings, []);
});

test('an explicit global marker is a decision, not a finding', () => {
    const out = checkTenantIsolation({ content: 'SELECT * FROM orders /* tenant:global */', tenantTables: tables });
    assert.deepEqual(out.findings, []);
});

test('schema-qualified names match by base table and keep the written name', () => {
    const out = checkTenantIsolation({ content: 'DELETE FROM public.orders', tenantTables: tables });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].table, 'public.orders');
});

test('one bad statement among several is reported once', () => {
    const out = checkTenantIsolation({
        content: 'UPDATE orders SET status = $1 WHERE tenant_id = $2; DELETE FROM invoices',
        tenantTables: tables,
    });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].table, 'invoices');
});

test('file-level results keep the file name on every finding', () => {
    const out = checkTenantFiles(
        [
            { file: 'migrations/001.sql', content: 'SELECT * FROM orders' },
            { file: 'queries/ok.sql', content: 'SELECT * FROM orders WHERE tenant_id = $1' },
        ],
        { tenantTables: tables },
    );
    assert.equal(out.files, 2);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'migrations/001.sql');
});
