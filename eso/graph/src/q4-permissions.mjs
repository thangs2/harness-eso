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
    db = null,
    project = null,
    coverage = 1.0,
} = {}) {
    if (!endpointId) throw new Error('endpointId is required');

    const database = db || (graph && typeof graph.all === 'function' ? graph : null);

    let endpoint = null;
    let grantRecord = null;
    let perm = null;

    if (database) {
        // Read endpoint from graph_node table
        const epNode = database.get(
            `SELECT id, name, metadata_json FROM graph_node WHERE (id = ? OR name = ?) AND kind = 'endpoint'`,
            [endpointId, endpointId]
        );

        if (epNode) {
            const meta = JSON.parse(epNode.metadata_json || '{}');
            // Find edge to permission: relation = 'requires' or 'declares'
            const permEdge = database.get(
                `SELECT ge.target_id, gn.id, gn.name, gn.metadata_json
                 FROM graph_edge ge
                 JOIN graph_node gn ON ge.target_id = gn.id
                 WHERE ge.source_id = ? AND (ge.relation = 'requires' OR ge.relation = 'declares') AND gn.kind = 'permission'`,
                [epNode.id]
            );

            if (permEdge) {
                const pMeta = JSON.parse(permEdge.metadata_json || '{}');
                perm = {
                    id: permEdge.id,
                    name: permEdge.name,
                    dynamic: pMeta.dynamic === true,
                };

                // Find edge from permission to grant
                const grantEdge = database.get(
                    `SELECT ge.target_id, gn.id, gn.name, gn.path, gn.metadata_json
                     FROM graph_edge ge
                     JOIN graph_node gn ON ge.target_id = gn.id
                     WHERE ge.source_id = ? AND (ge.relation = 'granted_by' OR ge.relation = 'maps_to') AND gn.kind = 'grant'`,
                    [permEdge.id]
                );

                if (grantEdge) {
                    const gMeta = JSON.parse(grantEdge.metadata_json || '{}');
                    grantRecord = {
                        id: grantEdge.id,
                        name: grantEdge.name,
                        location: grantEdge.path || gMeta.location,
                        deleted: gMeta.deleted === true,
                        dangling: gMeta.dangling === true,
                    };
                }
            } else if (meta.permission) {
                perm = meta.permission;
            }

            endpoint = {
                id: epNode.id,
                permission: perm,
            };
        }
    } else {
        const endpoints = graph.endpoints || [];
        endpoint = endpoints.find((e) => e.id === endpointId);
        perm = endpoint?.permission;
        const grants = graph.grants || [];
        if (perm) {
            grantRecord = grants.find((g) => g.permission_id === perm.id || g.permission_name === perm.name);
        }
    }

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

    const permObj = endpoint.permission;

    // AC-ARCH-05-02: Dynamic string concatenation / runtime dynamic expression
    if (permObj.dynamic || (typeof permObj.name === 'string' && permObj.name.includes('${'))) {
        return {
            status: 'unknown',
            code: 'DYNAMIC_UNKNOWN',
            endpoint: endpointId,
            message: 'khai động',
            completeness: coverage,
        };
    }

    // AC-ARCH-05-05 / ED10: Grant record deleted
    if (grantRecord && (grantRecord.deleted || grantRecord.dangling)) {
        return {
            status: 'unknown',
            code: 'DANGLING_GRANT',
            endpoint: endpointId,
            permission: permObj.name || permObj.id,
            dangling_grant_id: grantRecord.id,
            message: 'grant treo; không nói có grant',
            completeness: coverage,
        };
    }

    // AC-ARCH-05-03: Stating permission required without grant path is rejected
    if (!grantRecord) {
        const err = new Error(`NO_GRANT_PATH: Permission '${permObj.name || permObj.id}' declared without grant location`);
        err.code = 'NO_GRANT_PATH';
        err.endpoint = endpointId;
        err.permission = permObj.name || permObj.id;
        throw err;
    }

    // AC-ARCH-05-01: Happy path: 2 tiers endpoint -> permission -> grant
    return {
        status: 'answered',
        endpoint: endpointId,
        permission: permObj.name || permObj.id,
        grant: grantRecord.id,
        granted_at: grantRecord.location || grantRecord.granted_at,
        path: [endpointId, permObj.name || permObj.id, grantRecord.id],
        completeness: coverage,
    };
}
