/**
 * @mu/eso-graph — Q4 Endpoint Permissions Query (ESO-305 / US-ARCH-05)
 *
 * Implements:
 * - AC-ARCH-05-01: Static permission resolves 2-tier path: endpoint -> permission -> grant
 * - AC-ARCH-05-02: Dynamic permission (concatenated/runtime string) returns unknown + DYNAMIC_UNKNOWN
 * - AC-ARCH-05-03: Stating permission required without grant path is rejected with NO_GRANT_PATH
 * - AC-ARCH-05-04 / ED1: Endpoint declaring no permission returns unknown + PERM_UNDECLARED, never public
 * - AC-ARCH-05-05 / ED10: Grant record deleted surfaces DANGLING_GRANT, never claims valid grant
 */

export function queryEndpointPermissions({
    endpointId,
    graph = {},
    coverage = 1.0,
} = {}) {
    if (!endpointId) throw new Error('endpointId is required');

    const endpoints = graph.endpoints || [];
    const endpoint = endpoints.find((e) => e.id === endpointId);

    // AC-ARCH-05-04 / ED1: Undeclared permission on endpoint -> unknown, never infer public
    if (!endpoint || !endpoint.permission) {
        return {
            status: 'unknown',
            code: 'PERM_UNDECLARED',
            endpoint: endpointId,
            public: false,
            message: 'Endpoint không khai permission; không kết luận public',
            completeness: coverage,
        };
    }

    const perm = endpoint.permission;

    // AC-ARCH-05-02: Dynamic string concatenation / runtime dynamic expression
    if (perm.dynamic || (typeof perm.name === 'string' && perm.name.includes('${'))) {
        return {
            status: 'unknown',
            code: 'DYNAMIC_UNKNOWN',
            endpoint: endpointId,
            message: 'khai động',
            completeness: coverage,
        };
    }

    const grants = graph.grants || [];
    const grantRecord = grants.find((g) => g.permission_id === perm.id || g.permission_name === perm.name);

    // AC-ARCH-05-05 / ED10: Grant record deleted
    if (grantRecord && (grantRecord.deleted || grantRecord.dangling)) {
        return {
            status: 'unknown',
            code: 'DANGLING_GRANT',
            endpoint: endpointId,
            permission: perm.name || perm.id,
            dangling_grant_id: grantRecord.id,
            message: 'grant treo; không nói có grant',
            completeness: coverage,
        };
    }

    // AC-ARCH-05-03: Stating permission required without grant path is rejected
    if (!grantRecord) {
        const err = new Error(`NO_GRANT_PATH: Permission '${perm.name || perm.id}' declared without grant location`);
        err.code = 'NO_GRANT_PATH';
        err.endpoint = endpointId;
        err.permission = perm.name || perm.id;
        throw err;
    }

    // AC-ARCH-05-01: Happy path: 2 tiers endpoint -> permission -> grant
    return {
        status: 'answered',
        endpoint: endpointId,
        permission: perm.name || perm.id,
        grant: grantRecord.id,
        granted_at: grantRecord.location || grantRecord.granted_at,
        path: [endpointId, perm.name || perm.id, grantRecord.id],
        completeness: coverage,
    };
}
