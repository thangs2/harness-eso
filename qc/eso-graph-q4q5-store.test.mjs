import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initSchema } from '../eso/graph/src/schema.mjs';
import {
    queryEndpointPermissions,
    querySliceTenantBoundary,
} from '../eso/graph/src/index.mjs';

function createGraphDb() {
    const db = createDbAdapter(':memory:');
    initSchema(db);
    return db;
}

test('ESO-386 (B8): Q4 queryEndpointPermissions reads from DB graph store', () => {
    const db = createGraphDb();
    const project = 'tenant-store-q4';

    // 1. Insert endpoint, permission, grant nodes into graph_node
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
         ('ep-1', ?, 'endpoint', 'POST /orders', 'src/api/orders.ts', '{}', '2026-11-04', '2026-11-04'),
         ('perm-1', ?, 'permission', 'order:create', '', '{\"dynamic\":false}', '2026-11-04', '2026-11-04'),
         ('grant-1', ?, 'grant', 'role:order-manager', 'auth/roles.json', '{\"deleted\":false}', '2026-11-04', '2026-11-04')`,
        [project, project, project]
    );

    // 2. Insert edges into graph_edge
    db.run(
        `INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
         ('e1', ?, 'ep-1', 'perm-1', 'requires', '2026-11-04'),
         ('e2', ?, 'perm-1', 'grant-1', 'granted_by', '2026-11-04')`,
        [project, project]
    );

    // 3. Query endpoint permissions with db
    const res = queryEndpointPermissions({
        db,
        endpointId: 'ep-1',
        project,
    });

    assert.equal(res.status, 'answered');
    assert.equal(res.endpoint, 'ep-1');
    assert.equal(res.permission, 'order:create');
    assert.equal(res.grant, 'grant-1');
    assert.equal(res.granted_at, 'auth/roles.json');
    assert.deepEqual(res.path, ['ep-1', 'order:create', 'grant-1']);

    // 4. Undeclared endpoint in DB returns unknown (unknown != absent, BR-05)
    const undeclared = queryEndpointPermissions({
        db,
        endpointId: 'ep-nonexistent',
        project,
    });
    assert.equal(undeclared.status, 'unknown');
    assert.equal(undeclared.code, 'PERM_UNDECLARED');
    assert.equal(undeclared.public, false);
});

test('ESO-386 (B8): Q5 querySliceTenantBoundary reads from DB graph store', () => {
    const db = createGraphDb();
    const project = 'tenant-store-q5';

    // 1. Insert slice node and table nodes
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
         ('slice-billing', ?, 'slice', 'billing-slice', '', '{}', '2026-11-04', '2026-11-04'),
         ('tbl-invoices', ?, 'table', 'invoices', 'db/invoices.sql', '{\"has_tenant_marker\":true,\"tenant_marker\":\"tenant_id\"}', '2026-11-04', '2026-11-04'),
         ('tbl-logs', ?, 'table', 'system_logs', 'db/logs.sql', '{\"has_tenant_marker\":false}', '2026-11-04', '2026-11-04')`,
        [project, project, project]
    );

    // 2. Insert edge slice -> tables
    db.run(
        `INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
         ('e_slice_1', ?, 'slice-billing', 'tbl-invoices', 'touches', '2026-11-04'),
         ('e_slice_2', ?, 'slice-billing', 'tbl-logs', 'touches', '2026-11-04')`,
        [project, project]
    );

    // 3. Query slice tenant boundary with db
    const res = querySliceTenantBoundary({
        db,
        sliceId: 'slice-billing',
        coverage: 1.0,
    });

    assert.equal(res.status, 'answered');
    assert.equal(res.slice_id, 'slice-billing');
    assert.equal(res.touches_tenant, true);
    assert.equal(res.evidence.length, 1);
    assert.equal(res.evidence[0].table, 'invoices');
    assert.equal(res.evidence[0].marker, 'tenant_id');

    // 4. Low coverage rejects claim of no-tenant with status: 'unknown' (unknown != absent)
    const lowCov = querySliceTenantBoundary({
        db,
        sliceId: 'slice-billing',
        coverage: 0.50, // below floor 0.70
    });
    assert.equal(lowCov.status, 'unknown');
    assert.equal(lowCov.code, 'LOW_COVERAGE');
});
