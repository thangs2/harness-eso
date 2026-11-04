import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryEndpointPermissions,
    querySliceTenantBoundary,
} from '../eso/graph/src/index.mjs';

test('SCN-ARCH-05-01 (AC-ARCH-05-01): Static permission resolves 2-tier path endpoint -> permission -> grant', () => {
    const graph = {
        endpoints: [
            { id: 'ep-get-user', permission: { id: 'perm-user-read', name: 'user:read' } },
        ],
        grants: [
            { id: 'grant-operator', permission_id: 'perm-user-read', location: 'auth/roles.json' },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-get-user',
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
            { id: 'ep-dynamic', permission: { dynamic: true, name: 'user:${action}' } },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-dynamic',
        graph,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'DYNAMIC_UNKNOWN');
    assert.ok(result.message.includes('khai động'));
});

test('SCN-ARCH-05-03 (AC-ARCH-05-03): Permission stated without grant path is rejected with NO_GRANT_PATH', () => {
    const graph = {
        endpoints: [
            { id: 'ep-ungranted', permission: { id: 'perm-missing-grant', name: 'admin:super' } },
        ],
        grants: [], // 0 grants
    };

    assert.throws(() => {
        queryEndpointPermissions({
            endpointId: 'ep-ungranted',
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
            { id: 'ep-undeclared', permission: null },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-undeclared',
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
            { id: 'ep-dangling', permission: { id: 'perm-audit', name: 'audit:export' } },
        ],
        grants: [
            { id: 'grant-old', permission_id: 'perm-audit', deleted: true },
        ],
    };

    const result = queryEndpointPermissions({
        endpointId: 'ep-dangling',
        graph,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'DANGLING_GRANT');
    assert.equal(result.dangling_grant_id, 'grant-old');
    assert.ok(result.message.includes('grant treo'));
});

test('SCN-ARCH-06-01 (AC-ARCH-06-01): Coverage >= 0.95 answers with yes/no and evidence', () => {
    const tables = [
        { name: 'orders', has_tenant_marker: true, tenant_marker: 'org_id' },
        { name: 'products', has_tenant_marker: false },
    ];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-checkout',
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
    const tables = [{ name: 'invoices', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-billing',
        tables,
        coverage: 1.0,
        isImplicit: true, // inferred from schema, undeclared
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'LOW_COVERAGE');
    assert.ok(result.message.includes('tenant ngầm'));
});

test('SCN-ARCH-06-03 (AC-ARCH-06-03): Coverage < 0.70 rejects claim "không chạm tenant" with LOW_COVERAGE', () => {
    const tables = [{ name: 'public_catalog', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-catalog',
        tables,
        coverage: 0.65, // < 0.70 floor
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'LOW_COVERAGE');
    assert.ok(result.message.includes('từ chối phát biểu không chạm tenant'));
});

test('SCN-ARCH-06-04 (AC-ARCH-06-04 / ED4): Coverage exactly 0.70 is answerable (boundary inclusive)', () => {
    const tables = [{ name: 'public_catalog', has_tenant_marker: false }];

    const result = querySliceTenantBoundary({
        sliceId: 'slice-catalog',
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
        tables: [], // 0 tables
        coverage: 1.0,
    });

    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'EMPTY_SLICE');
    assert.ok(result.message.includes('slice rỗng'));
});
