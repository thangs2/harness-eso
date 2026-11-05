import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryEndpointPermissions,
    querySliceTenantBoundary,
} from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('ESO-386 (B8): Q4 queryEndpointPermissions reads from DB graph store on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'tenant-store-q4';

    try {
        // 1. Insert endpoint, permission, grant nodes into graph_node
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, 'b1', 'ep-1', 'endpoint', 'POST /orders', 'src/api/orders.ts'),
             (?, 'b1', 'perm-1', 'permission', 'order:create', ''),
             (?, 'b1', 'grant-1', 'doc', 'role:order-manager', 'auth/roles.json')`,
            [project, project, project]
        );

        // 2. Insert edges into graph_edge
        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             (?, 'b1', 'e1', 'ep-1', 'perm-1', 'requires', false),
             (?, 'b1', 'e2', 'perm-1', 'grant-1', 'specifies', false)`,
            [project, project]
        );

        // 3. Query endpoint permissions with db and coverage: 1.0
        const res = await queryEndpointPermissions({
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
        const missingCov = await queryEndpointPermissions({
            db,
            endpointId: 'ep-1',
            project,
        });
        assert.equal(missingCov.status, 'unknown');
        assert.equal(missingCov.code, 'COVERAGE_REQUIRED');
        assert.deepEqual(missingCov.unknowns, ['coverage_missing']);

        // 4. Undeclared endpoint in DB returns unknown (unknown != absent, BR-05)
        const undeclared = await queryEndpointPermissions({
            db,
            endpointId: 'ep-nonexistent',
            project,
        });
        assert.equal(undeclared.status, 'unknown');
        assert.equal(undeclared.code, 'PERM_UNDECLARED');
        assert.equal(undeclared.public, false);
    } finally {
        await pg.cleanup();
    }
});

test('ESO-386 (B8): Multi-project isolation in Q4 and Q5 queries', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const projA = 'project-alpha';
    const projB = 'project-beta';

    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, 'b1', 'ep-common-a', 'endpoint', 'ep-common', 'src/a.ts'),
             (?, 'b1', 'perm-a', 'permission', 'perm:alpha', ''),
             (?, 'b1', 'grant-a', 'doc', 'grant:alpha', 'roles-a.json'),
             (?, 'b1', 'ep-common-b', 'endpoint', 'ep-common', 'src/b.ts'),
             (?, 'b1', 'perm-b', 'permission', 'perm:beta', ''),
             (?, 'b1', 'grant-b', 'doc', 'grant:beta', 'roles-b.json')`,
            [projA, projA, projA, projB, projB, projB]
        );

        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             (?, 'b1', 'ea1', 'ep-common-a', 'perm-a', 'requires', false),
             (?, 'b1', 'ea2', 'perm-a', 'grant-a', 'specifies', false),
             (?, 'b1', 'eb1', 'ep-common-b', 'perm-b', 'requires', false),
             (?, 'b1', 'eb2', 'perm-b', 'grant-b', 'specifies', false)`,
            [projA, projA, projB, projB]
        );

        const resA = await queryEndpointPermissions({
            db,
            endpointId: 'ep-common',
            project: projA,
            coverage: 1.0,
        });
        assert.equal(resA.status, 'answered');
        assert.equal(resA.permission, 'perm:alpha');
        assert.equal(resA.grant, 'grant-a');

        const resB = await queryEndpointPermissions({
            db,
            endpointId: 'ep-common',
            project: projB,
            coverage: 1.0,
        });
        assert.equal(resB.status, 'answered');
        assert.equal(resB.permission, 'perm:beta');
        assert.equal(resB.grant, 'grant-b');
    } finally {
        await pg.cleanup();
    }
});

test('ESO-386 (B8): Q5 querySliceTenantBoundary reads from DB graph store on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'tenant-store-q5';

    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, 'b1', 'slice-billing', 'module', 'billing-slice', ''),
             (?, 'b1', 'tbl-invoices', 'table', 'invoices', 'db/invoices.sql'),
             (?, 'b1', 'tbl-logs', 'table', 'system_logs', 'db/logs.sql')`,
            [project, project, project]
        );

        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             (?, 'b1', 'e_slice_1', 'slice-billing', 'tbl-invoices', 'tenant_marker', false),
             (?, 'b1', 'e_slice_2', 'slice-billing', 'tbl-logs', 'references', false)`,
            [project, project]
        );

        const res = await querySliceTenantBoundary({
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
        assert.equal(res.evidence[0].marker, 'tenant_marker');

        const missingCov = await querySliceTenantBoundary({
            db,
            sliceId: 'slice-billing',
            project,
        });
        assert.equal(missingCov.status, 'unknown');
        assert.equal(missingCov.code, 'COVERAGE_REQUIRED');
        assert.deepEqual(missingCov.unknowns, ['coverage_missing']);

        const otherProj = await querySliceTenantBoundary({
            db,
            sliceId: 'slice-billing',
            project: 'different-project',
            coverage: 1.0,
        });
        assert.equal(otherProj.status, 'unknown');
        assert.equal(otherProj.code, 'EMPTY_SLICE');
        assert.deepEqual(otherProj.unknowns, ['empty_slice']);

        const lowCov = await querySliceTenantBoundary({
            db,
            sliceId: 'slice-billing',
            project,
            coverage: 0.50,
        });
        assert.equal(lowCov.status, 'unknown');
        assert.equal(lowCov.code, 'LOW_COVERAGE');
    } finally {
        await pg.cleanup();
    }
});
