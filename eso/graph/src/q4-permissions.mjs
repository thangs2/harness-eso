/**
 * @mu/eso-graph — Q4 Endpoint Permissions Query (ESO-305 / US-ARCH-05 / ESO-447)
 *
 * Implements:
 * - Target columns: graph_node(project, build_id, node_id, kind, node_key, path)
 *                   graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 * - AC-ARCH-05-01: Static permission resolves 2-tier path: endpoint -> permission -> grant
 * - AC-ARCH-05-02: Dynamic permission (concatenated/runtime string) returns unknown + DYNAMIC_UNKNOWN
 * - AC-ARCH-05-03: Stating permission required without grant path is rejected with NO_GRANT_PATH
 * - AC-ARCH-05-04 / ED1: Endpoint declaring no permission returns unknown + PERM_UNDECLARED, never public
 * - AC-ARCH-05-05 / ED10: Grant record deleted surfaces DANGLING_GRANT, never claims valid grant
 */

function evaluateEndpointPermissions({ endpoint, grantRecord, endpointId, proj, coverage }) {
    // AC-ARCH-05-04 / ED1: Undeclared permission on endpoint -> unknown, never infer public
    if (!endpoint || !endpoint.permission) {
        return {
            status: 'unknown',
            code: 'PERM_UNDECLARED',
            endpoint: endpointId,
            public: false,
            unknowns: ['PERM_UNDECLARED'],
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
            unknowns: ['DYNAMIC_UNKNOWN'],
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
            unknowns: ['DANGLING_GRANT'],
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

    // Missing coverage or incomplete coverage returns unknown (DoD B8 / ESO-386)
    if (coverage === null || coverage === undefined || typeof coverage !== 'number') {
        return {
            status: 'unknown',
            code: 'COVERAGE_REQUIRED',
            endpoint: endpointId,
            unknowns: ['coverage_missing'],
            message: 'Thiếu coverage; không đủ dữ liệu kết luận permission',
            completeness: null,
        };
    }

    if (coverage < 1.0) {
        return {
            status: 'unknown',
            code: 'LOW_COVERAGE',
            endpoint: endpointId,
            unknowns: ['incomplete_coverage'],
            message: 'Độ phủ < 1.0; không đủ dữ liệu kết luận permission',
            completeness: coverage,
        };
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

export function queryEndpointPermissions({
    endpointId,
    graph = {},
    db = null,
    project = null,
    coverage = null,
    buildId = null,
} = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        const err = new Error('project is mandatory');
        err.code = 'INVALID_PROJECT';
        throw err;
    }
    if (!endpointId) throw new Error('endpointId is required');

    const proj = project.trim();
    const database = db || (graph && typeof graph.all === 'function' ? graph : null);

    if (database) {
        return (async () => {
            const epSql = `SELECT node_id AS id, node_key AS name, path, project FROM graph_node WHERE (node_id = ? OR node_key = ?) AND kind = 'endpoint' AND project = ?` + (buildId ? ' AND build_id = ?' : '');
            const epParams = buildId ? [endpointId, endpointId, proj, buildId] : [endpointId, endpointId, proj];
            const epNode = await database.get(epSql, epParams);

            let endpoint = null;
            let grantRecord = null;
            let perm = null;

            if (epNode) {
                const permSql = `SELECT ge.to_node_id AS target_id, gn.node_id AS id, gn.node_key AS name, gn.path
                     FROM graph_edge ge
                     JOIN graph_node gn ON ge.to_node_id = gn.node_id
                     WHERE ge.from_node_id = ? AND (ge.kind = 'requires' OR ge.kind = 'defines' OR ge.kind = 'references') AND gn.kind = 'permission'
                       AND ge.project = ? AND gn.project = ?` + (buildId ? ' AND ge.build_id = ? AND gn.build_id = ?' : '');
                const permParams = buildId ? [epNode.id, proj, proj, buildId, buildId] : [epNode.id, proj, proj];
                const permEdge = await database.get(permSql, permParams);

                if (permEdge) {
                    perm = {
                        id: permEdge.id,
                        name: permEdge.name,
                        dynamic: typeof permEdge.name === 'string' && permEdge.name.includes('${'),
                    };

                    const grantSql = `SELECT ge.to_node_id AS target_id, gn.node_id AS id, gn.node_key AS name, gn.path
                         FROM graph_edge ge
                         JOIN graph_node gn ON ge.to_node_id = gn.node_id
                         WHERE ge.from_node_id = ? AND (ge.kind = 'granted_by' OR ge.kind = 'maps_to' OR ge.kind = 'defines' OR ge.kind = 'specifies')
                           AND ge.project = ? AND gn.project = ?` + (buildId ? ' AND ge.build_id = ? AND gn.build_id = ?' : '');
                    const grantParams = buildId ? [permEdge.id, proj, proj, buildId, buildId] : [permEdge.id, proj, proj];
                    const grantEdge = await database.get(grantSql, grantParams);

                    if (grantEdge) {
                        grantRecord = {
                            id: grantEdge.id,
                            name: grantEdge.name,
                            location: grantEdge.path,
                            deleted: false,
                            dangling: false,
                        };
                    }
                }

                endpoint = {
                    id: epNode.id,
                    permission: perm,
                    project: proj,
                };
            }

            return evaluateEndpointPermissions({ endpoint, grantRecord, endpointId, proj, coverage });
        })();
    }

    const endpoints = graph.endpoints || [];
    const endpoint = endpoints.find((e) => (e.id === endpointId || e.name === endpointId) && e.project === proj);
    const perm = endpoint?.permission;
    const grants = graph.grants || [];
    let grantRecord = null;
    if (perm) {
        grantRecord = grants.find((g) => (g.permission_id === perm.id || g.permission_id === perm.name) && g.project === proj);
    }

    return evaluateEndpointPermissions({ endpoint, grantRecord, endpointId, proj, coverage });
}
