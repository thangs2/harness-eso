/**
 * @mu/eso-graph — Q5 Slice Tenant Boundary Query (ESO-211 / US-ARCH-06 / ESO-447)
 *
 * Implements:
 * - Target columns: graph_node(project, build_id, node_id, kind, node_key, path)
 *                   graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 * - AC-ARCH-06-01: Tenant marker coverage >= 0.95 answers with yes/no and evidence
 * - AC-ARCH-06-02: Implicit tenant (inferred from schema, not declared) returns unknown + LOW_COVERAGE
 * - AC-ARCH-06-03: Coverage < 0.70 rejects claim "không chạm tenant" with LOW_COVERAGE
 * - AC-ARCH-06-04 / ED4: Coverage exactly 0.70 is answerable (threshold closed at 0.70, only < 0.70 is unknown)
 * - AC-ARCH-06-05 / ED1: Slice with 0 tables returns unknown + EMPTY_SLICE
 */

export const TENANT_COVERAGE_FLOOR = 0.70;

function evaluateSliceTenant({ sliceId, resolvedTables, coverage, isImplicit }) {
    // AC-ARCH-06-05 / ED1: Slice with 0 tables -> unknown + EMPTY_SLICE
    if (resolvedTables.length === 0) {
        return {
            status: 'unknown',
            code: 'EMPTY_SLICE',
            slice_id: sliceId,
            unknowns: ['empty_slice'],
            message: 'Slice 0 bảng (slice rỗng); không thể xác định ranh giới tenant',
            completeness: coverage,
        };
    }

    // AC-ARCH-06-02: Implicit tenant inferred from schema, undeclared
    if (isImplicit) {
        return {
            status: 'unknown',
            code: 'LOW_COVERAGE',
            slice_id: sliceId,
            unknowns: ['implicit_tenant'],
            message: 'tenant ngầm; không kết luận không chạm',
            completeness: coverage,
        };
    }

    // Missing coverage specification returns unknown (DoD B8 / ESO-386)
    if (coverage === null || coverage === undefined || typeof coverage !== 'number') {
        return {
            status: 'unknown',
            code: 'COVERAGE_REQUIRED',
            slice_id: sliceId,
            unknowns: ['coverage_missing'],
            message: 'Thiếu coverage; không đủ dữ liệu kết luận tenant boundary',
            completeness: null,
        };
    }

    // AC-ARCH-06-03 & AC-ARCH-06-04 / ED4: Floor check
    if (coverage < TENANT_COVERAGE_FLOOR) {
        return {
            status: 'unknown',
            code: 'LOW_COVERAGE',
            slice_id: sliceId,
            unknowns: ['low_tenant_coverage'],
            message: 'Độ phủ < 0.70: từ chối phát biểu không chạm tenant',
            completeness: coverage,
        };
    }

    // Check if tables in slice touch tenant boundary
    const touchingTables = resolvedTables.filter((t) => t.has_tenant_marker || t.cross_tenant);
    const touchesTenant = touchingTables.length > 0;

    return {
        status: 'answered',
        slice_id: sliceId,
        touches_tenant: touchesTenant,
        evidence: touchingTables.map((t) => ({
            table: t.name || t.id,
            marker: t.tenant_marker || 'tenant_id',
        })),
        completeness: coverage,
    };
}

export function querySliceTenantBoundary({
    sliceId,
    project = null,
    tables = [],
    graph = null,
    db = null,
    coverage = null,
    isImplicit = false,
    buildId = null,
} = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        const err = new Error('project is mandatory');
        err.code = 'INVALID_PROJECT';
        throw err;
    }
    if (!sliceId) throw new Error('sliceId is required');

    const proj = project.trim();
    const database = db || (graph && typeof graph.all === 'function' ? graph : null);
    let resolvedTables = Array.isArray(tables) ? tables.filter((t) => !t.project || t.project === proj) : [];

    if (database && resolvedTables.length === 0) {
        return (async () => {
            const sql = `SELECT gn.node_id AS id, gn.node_key AS name, gn.path, ge.kind AS edge_kind
                 FROM graph_node gn
                 JOIN graph_edge ge ON (ge.to_node_id = gn.node_id OR ge.from_node_id = gn.node_id)
                 WHERE (ge.from_node_id = ? OR ge.to_node_id = ?) AND gn.kind = 'table'
                   AND gn.project = ? AND ge.project = ?` + (buildId ? ' AND gn.build_id = ? AND ge.build_id = ?' : '');
            const params = buildId ? [sliceId, sliceId, proj, proj, buildId, buildId] : [sliceId, sliceId, proj, proj];
            const rows = (await database.all(sql, params)) || [];

            const tablesFromDb = rows.map((r) => {
                const isTenantEdge = r.edge_kind === 'tenant_marker';
                return {
                    id: r.id,
                    name: r.name,
                    has_tenant_marker: isTenantEdge || (typeof r.name === 'string' && r.name.includes('tenant')),
                    tenant_marker: isTenantEdge ? 'tenant_marker' : null,
                    cross_tenant: isTenantEdge,
                };
            });

            return evaluateSliceTenant({ sliceId, resolvedTables: tablesFromDb, coverage, isImplicit });
        })();
    }

    return evaluateSliceTenant({ sliceId, resolvedTables, coverage, isImplicit });
}
