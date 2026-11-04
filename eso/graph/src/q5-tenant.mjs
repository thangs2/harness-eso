/**
 * @mu/eso-graph — Q5 Slice Tenant Boundary Query (ESO-211 / US-ARCH-06)
 *
 * Implements:
 * - AC-ARCH-06-01: Tenant marker coverage >= 0.95 answers with yes/no and evidence
 * - AC-ARCH-06-02: Implicit tenant (inferred from schema, not declared) returns unknown + LOW_COVERAGE
 * - AC-ARCH-06-03: Coverage < 0.70 rejects claim "không chạm tenant" with LOW_COVERAGE
 * - AC-ARCH-06-04 / ED4: Coverage exactly 0.70 is answerable (threshold closed at 0.70, only < 0.70 is unknown)
 * - AC-ARCH-06-05 / ED1: Slice with 0 tables returns unknown + EMPTY_SLICE
 */

export const TENANT_COVERAGE_FLOOR = 0.70;

export function querySliceTenantBoundary({
    sliceId,
    project = null,
    tables = [],
    graph = null,
    db = null,
    coverage = null,
    isImplicit = false,
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
        // Read table nodes associated with slice
        const sql = `SELECT gn.id, gn.name, gn.metadata_json
             FROM graph_node gn
             JOIN graph_edge ge ON (ge.target_id = gn.id OR ge.source_id = gn.id)
             WHERE (ge.source_id = ? OR ge.target_id = ?) AND gn.kind = 'table'
               AND gn.project = ? AND ge.project = ?`;
        const params = [sliceId, sliceId, proj, proj];
        const rows = database.all(sql, params) || [];

        resolvedTables = rows.map((r) => {
            const meta = JSON.parse(r.metadata_json || '{}');
            return {
                id: r.id,
                name: r.name,
                has_tenant_marker: meta.has_tenant_marker === true || Boolean(meta.tenant_marker),
                tenant_marker: meta.tenant_marker || null,
                cross_tenant: meta.cross_tenant === true,
            };
        });
    }

    // AC-ARCH-06-05 / ED1: Slice with 0 tables -> unknown + EMPTY_SLICE
    if (resolvedTables.length === 0) {
        return {
            status: 'unknown',
            code: 'EMPTY_SLICE',
            slice_id: sliceId,
            unknowns: ['empty_slice'],
            message: 'slice rỗng; không kết luận không chạm',
            completeness: coverage,
        };
    }

    // AC-ARCH-06-02: Implicit tenant (inferred without explicit declaration) -> unknown
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
    // If coverage < 0.70 -> rejected with LOW_COVERAGE
    // If coverage >= 0.70 (including exactly 0.70) -> answerable!
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
    // Tables touching tenant: either cross_tenant is true, or tenant_marker is present
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
