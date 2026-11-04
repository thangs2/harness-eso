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
    tables = [],
    coverage = 1.0,
    isImplicit = false,
} = {}) {
    if (!sliceId) throw new Error('sliceId is required');

    // AC-ARCH-06-05 / ED1: Slice with 0 tables -> unknown + EMPTY_SLICE
    if (!Array.isArray(tables) || tables.length === 0) {
        return {
            status: 'unknown',
            code: 'EMPTY_SLICE',
            slice_id: sliceId,
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
            message: 'tenant ngầm; không kết luận không chạm',
            completeness: coverage,
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
            message: 'Độ phủ < 0.70: từ chối phát biểu không chạm tenant',
            completeness: coverage,
        };
    }

    // Check if tables in slice touch tenant boundary
    // Tables touching tenant: either cross_tenant is true, or tenant_marker is present
    const touchingTables = tables.filter((t) => t.has_tenant_marker || t.cross_tenant);
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
