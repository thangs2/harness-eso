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

    // 3. Query endpoint permissions with db and coverage: 1.0
    const res = queryEndpointPermissions({
        db,
        endpointId: 'ep-1',
        project,
        coverage: 1.0,
    });

    assert.equal(res.status, 'answered');
    assert.equal(res.endpoint, 'ep-1');
    assert.equal(res.permission, 'order:create');
    assert.equal(res.grant, 'grant-1');
    assert.equal(res.granted_at, 'auth/roles.json');
    assert.deepEqual(res.path, ['ep-1', 'order:create', 'grant-1']);

    // 3b. Missing coverage returns status: unknown + COVERAGE_REQUIRED (DoD B8 / ESO-386)
    const missingCov = queryEndpointPermissions({
        db,
        endpointId: 'ep-1',
        project,
    });
    assert.equal(missingCov.status, 'unknown');
    assert.equal(missingCov.code, 'COVERAGE_REQUIRED');
    assert.deepEqual(missingCov.unknowns, ['coverage_missing']);

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

test('ESO-386 (B8): Multi-project isolation in Q4 and Q5 queries', () => {
    const db = createGraphDb();
    const projA = 'project-alpha';
    const projB = 'project-beta';

    // Insert same endpoint id 'ep-common' into project-alpha and project-beta
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
         ('ep-common-a', ?, 'endpoint', 'ep-common', 'src/a.ts', '{}', '2026-11-04', '2026-11-04'),
         ('perm-a', ?, 'permission', 'perm:alpha', '', '{\"dynamic\":false}', '2026-11-04', '2026-11-04'),
         ('grant-a', ?, 'grant', 'grant:alpha', 'roles-a.json', '{\"deleted\":false}', '2026-11-04', '2026-11-04'),
         ('ep-common-b', ?, 'endpoint', 'ep-common', 'src/b.ts', '{}', '2026-11-04', '2026-11-04'),
         ('perm-b', ?, 'permission', 'perm:beta', '', '{\"dynamic\":false}', '2026-11-04', '2026-11-04'),
         ('grant-b', ?, 'grant', 'grant:beta', 'roles-b.json', '{\"deleted\":false}', '2026-11-04', '2026-11-04')`,
        [projA, projA, projA, projB, projB, projB]
    );

    db.run(
        `INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
         ('ea1', ?, 'ep-common-a', 'perm-a', 'requires', '2026-11-04'),
         ('ea2', ?, 'perm-a', 'grant-a', 'granted_by', '2026-11-04'),
         ('eb1', ?, 'ep-common-b', 'perm-b', 'requires', '2026-11-04'),
         ('eb2', ?, 'perm-b', 'grant-b', 'granted_by', '2026-11-04')`,
        [projA, projA, projB, projB]
    );

    // Querying project-alpha returns perm:alpha, never leaks perm:beta
    const resA = queryEndpointPermissions({
        db,
        endpointId: 'ep-common',
        project: projA,
        coverage: 1.0,
    });
    assert.equal(resA.status, 'answered');
    assert.equal(resA.permission, 'perm:alpha');
    assert.equal(resA.grant, 'grant-a');

    // Querying project-beta returns perm:beta
    const resB = queryEndpointPermissions({
        db,
        endpointId: 'ep-common',
        project: projB,
        coverage: 1.0,
    });
    assert.equal(resB.status, 'answered');
    assert.equal(resB.permission, 'perm:beta');
    assert.equal(resB.grant, 'grant-b');
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
        project,
        coverage: 1.0,
    });

    assert.equal(res.status, 'answered');
    assert.equal(res.slice_id, 'slice-billing');
    assert.equal(res.touches_tenant, true);
    assert.equal(res.evidence.length, 1);
    assert.equal(res.evidence[0].table, 'invoices');
    assert.equal(res.evidence[0].marker, 'tenant_id');

    // 3b. Missing coverage returns status: unknown + COVERAGE_REQUIRED (DoD B8 / ESO-386)
    const missingCov = querySliceTenantBoundary({
        db,
        sliceId: 'slice-billing',
        project,
    });
    assert.equal(missingCov.status, 'unknown');
    assert.equal(missingCov.code, 'COVERAGE_REQUIRED');
    assert.deepEqual(missingCov.unknowns, ['coverage_missing']);

    // 3c. Querying for another project returns EMPTY_SLICE because no tables belong to other project
    const otherProj = querySliceTenantBoundary({
        db,
        sliceId: 'slice-billing',
        project: 'different-project',
        coverage: 1.0,
    });
    assert.equal(otherProj.status, 'unknown');
    assert.equal(otherProj.code, 'EMPTY_SLICE');
    assert.deepEqual(otherProj.unknowns, ['empty_slice']);

    // 4. Low coverage rejects claim of no-tenant with status: 'unknown' (unknown != absent)
    const lowCov = querySliceTenantBoundary({
        db,
        sliceId: 'slice-billing',
        project,
        coverage: 0.50, // below floor 0.70
    });
    assert.equal(lowCov.status, 'unknown');
    assert.equal(lowCov.code, 'LOW_COVERAGE');
});
