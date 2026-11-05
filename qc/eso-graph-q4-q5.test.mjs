import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryEndpointPermissions,
    querySliceTenantBoundary,
} from '../eso/graph/src/index.mjs';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initSchema } from '../eso/graph/src/schema.mjs';

test('SCN-ARCH-05-01 (AC-ARCH-05-01): Static permission resolves 2-tier path endpoint -> permission -> grant', () => {
    const graph = {
        endpoints: [
            { id: 'ep-get-user', project: 'default', permission: { id: 'perm-user-read', name: 'user:read' } },
        ],
        grants: [
            { id: 'grant-operator', project: 'default', permission_id: 'perm-user-read', location: 'auth/roles.json' },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-get-user',
        project: 'default',
        graph,
        coverage: 1.0,
    });

    assert.equal(result.status, 'answered');
    assert.equal(result.endpoint, 'ep-get-user');
    assert.equal(result.permission, 'user:read');
    assert.equal(result.grant, 'grant-operator');
    assert.equal(result.granted_at, 'auth/roles.json');
    assert.deepEqual(result.path, ['ep-get-user', 'user:read', 'grant-operator']);
    assert.equal(result.completeness, 1.0);
});

test('SCN-ARCH-05-02 (AC-ARCH-05-02): Dynamic concatenated permission returns unknown + DYNAMIC_UNKNOWN', () => {
    const graph = {
        endpoints: [
            { id: 'ep-dynamic', project: 'default', permission: { dynamic: true, name: 'user:${action}' } },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-dynamic',
        project: 'default',
        graph,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'DYNAMIC_UNKNOWN');
    assert.ok(result.message.includes('khai động'));
});

test('SCN-ARCH-05-03 (AC-ARCH-05-03): Permission stated without grant path is rejected with NO_GRANT_PATH', () => {
    const graph = {
        endpoints: [
            { id: 'ep-ungranted', project: 'default', permission: { id: 'perm-missing-grant', name: 'admin:super' } },
        ],
        grants: [], // 0 grants
    };

    assert.throws(() => {
        queryEndpointPermissions({
            endpointId: 'ep-ungranted',
            project: 'default',
            graph,
        });
    }, (err) => {
        assert.equal(err.code, 'NO_GRANT_PATH');
        assert.equal(err.permission, 'admin:super');
        return true;
    });
});

test('SCN-ARCH-05-04 (AC-ARCH-05-04 / ED1): Endpoint declaring no permission returns unknown + PERM_UNDECLARED, never public', () => {
    const graph = {
        endpoints: [
            { id: 'ep-undeclared', project: 'default', permission: null },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-undeclared',
        project: 'default',
        graph,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'PERM_UNDECLARED');
    assert.equal(result.public, false);
    assert.ok(result.message.includes('không kết luận public'));
});

test('SCN-ARCH-05-05 (AC-ARCH-05-05 / ED10): Deleted grant record surfaces DANGLING_GRANT, never claims valid grant', () => {
    const graph = {
        endpoints: [
            { id: 'ep-dangling', project: 'default', permission: { id: 'perm-audit', name: 'audit:export' } },
        ],
        grants: [
            { id: 'grant-old', project: 'default', permission_id: 'perm-audit', deleted: true },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-dangling',
        project: 'default',
        graph,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'DANGLING_GRANT');
    assert.equal(result.dangling_grant_id, 'grant-old');
    assert.ok(result.message.includes('grant treo'));
});

test('ESO-386 / Tenant Isolation: queryEndpointPermissions strictly enforces mandatory project parameter', () => {
    assert.throws(() => {
        queryEndpointPermissions({
            endpointId: 'ep-1',
            // omitted project
        });
    }, (err) => {
        assert.equal(err.code, 'INVALID_PROJECT');
        return true;
    });

    assert.throws(() => {
        queryEndpointPermissions({
            endpointId: 'ep-1',
            project: '   ', // whitespace only
        });
    }, (err) => {
        assert.equal(err.code, 'INVALID_PROJECT');
        return true;
    });
});

import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('ESO-386 / Tenant Isolation: Q4 prevents cross-project grant leakage between distinct projects on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const D = '2026-11-05';

    try {
        // Proj A and Proj B share identical endpoint name 'POST /orders'
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             ('projA','b1','ep-A','endpoint','POST /orders','a.ts'),
             ('projB','b1','ep-B','endpoint','POST /orders','b.ts'),
             ('projA','b1','perm-A','permission','order:create',''),
             ('projB','b1','perm-B','permission','order:admin',''),
             ('projA','b1','grant-A','doc','role:A','rolesA.json'),
             ('projB','b1','grant-B','doc','role:B','rolesB.json')`
        );
        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             ('projA','b1','e-A1','ep-A','perm-A','requires',false),
             ('projA','b1','e-A2','perm-A','grant-A','specifies',false),
             ('projB','b1','e-B1','ep-B','perm-B','requires',false),
             ('projB','b1','e-B2','perm-B','grant-B','specifies',false)`
        );

        const resA = await queryEndpointPermissions({ db, endpointId: 'POST /orders', project: 'projA', coverage: 1.0 });
        assert.equal(resA.status, 'answered');
        assert.equal(resA.permission, 'order:create');
        assert.equal(resA.grant, 'grant-A');

        const resB = await queryEndpointPermissions({ db, endpointId: 'POST /orders', project: 'projB', coverage: 1.0 });
        assert.equal(resB.status, 'answered');
        assert.equal(resB.permission, 'order:admin');
        assert.equal(resB.grant, 'grant-B');

        // Unknown project returns unknown/not-found, never leaks from projA or projB
        const resZ = await queryEndpointPermissions({ db, endpointId: 'POST /orders', project: 'projZ', coverage: 1.0 });
        assert.equal(resZ.status, 'unknown');
        assert.equal(resZ.code, 'PERM_UNDECLARED');
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-06-01 (AC-ARCH-06-01): Coverage >= 0.95 answers with yes/no and evidence', () => {
    const tables = [
        { name: 'orders', project: 'default', has_tenant_marker: true, tenant_marker: 'org_id' },
        { name: 'products', project: 'default', has_tenant_marker: false },
    ];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-checkout',
        project: 'default',
        tables,
        coverage: 0.96,
    });

    assert.equal(result.status, 'answered');
    assert.equal(result.touches_tenant, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].table, 'orders');
    assert.equal(result.completeness, 0.96);
});

test('SCN-ARCH-06-02 (AC-ARCH-06-02): Implicit tenant returns unknown + LOW_COVERAGE without claiming non-touching', () => {
    const tables = [{ name: 'invoices', project: 'default', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-billing',
        project: 'default',
        tables,
        coverage: 1.0,
        isImplicit: true, // inferred from schema, undeclared
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'LOW_COVERAGE');
    assert.ok(result.message.includes('tenant ngầm'));
});

test('SCN-ARCH-06-03 (AC-ARCH-06-03): Coverage < 0.70 rejects claim "không chạm tenant" with LOW_COVERAGE', () => {
    const tables = [{ name: 'public_catalog', project: 'default', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-catalog',
        project: 'default',
        tables,
        coverage: 0.65, // < 0.70 floor
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'LOW_COVERAGE');
    assert.ok(result.message.includes('từ chối phát biểu không chạm tenant'));
});

test('SCN-ARCH-06-04 (AC-ARCH-06-04 / ED4): Coverage exactly 0.70 is answerable (boundary inclusive)', () => {
    const tables = [{ name: 'public_catalog', project: 'default', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-catalog',
        project: 'default',
        tables,
        coverage: 0.70, // exactly 0.70
    });

    assert.equal(result.status, 'answered');
    assert.equal(result.touches_tenant, false);
    assert.equal(result.completeness, 0.70);
});

test('SCN-ARCH-06-05 (AC-ARCH-06-05 / ED1): Slice with 0 tables returns unknown + EMPTY_SLICE', () => {
    const result = querySliceTenantBoundary({
        sliceId: 'empty-slice',
        project: 'default',
        tables: [], // 0 tables
        coverage: 1.0,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'EMPTY_SLICE');
    assert.ok(result.message.includes('slice rỗng'));
});

test('ESO-386 / Tenant Isolation: querySliceTenantBoundary enforces mandatory project parameter', () => {
    assert.throws(() => {
        querySliceTenantBoundary({
            sliceId: 'slice-1',
            tables: [{ name: 'orders' }],
        });
    }, (err) => {
        assert.equal(err.code, 'INVALID_PROJECT');
        return true;
    });
});
