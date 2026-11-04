/**
 * @mu/eso-graph — ESO Graph Architecture Domain (Slice S1)
 */

import { initSchema, SCHEMA_SQL, POSTGRES_RLS_SQL, TABLES } from './schema.mjs';
import { calculateCompleteness, QUESTION_KIND_MAP, resolveQuestionKinds } from './completeness.mjs';
import { isTurnSafe, dispatchQuery } from './dispatcher.mjs';
import { generateNodeId, extractProjectGraph } from './extractor.mjs';
import {
    queryReadSet,
    DEFAULT_THRESHOLD,
    DEFAULT_FLOOR,
    DEFAULT_MAX_FANOUT,
    ALLOWED_RELATIONS,
} from './q1-readset.mjs';
import {
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
    ALLOWED_RELATIONS_Q2,
} from './q2-impact.mjs';
import {
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
    ALLOWED_RELATIONS_Q3,
} from './q3-cycles.mjs';
import {
    queryEndpointPermissions,
} from './q4-permissions.mjs';
import {
    querySliceTenantBoundary,
    TENANT_COVERAGE_FLOOR,
} from './q5-tenant.mjs';

export {
    initSchema,
    SCHEMA_SQL,
    POSTGRES_RLS_SQL,
    TABLES,
    calculateCompleteness,
    QUESTION_KIND_MAP,
    resolveQuestionKinds,
    isTurnSafe,
    dispatchQuery,
    generateNodeId,
    extractProjectGraph,
    queryReadSet,
    DEFAULT_THRESHOLD,
    DEFAULT_FLOOR,
    DEFAULT_MAX_FANOUT,
    ALLOWED_RELATIONS,
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
    ALLOWED_RELATIONS_Q2,
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
    ALLOWED_RELATIONS_Q3,
    queryEndpointPermissions,
    querySliceTenantBoundary,
    TENANT_COVERAGE_FLOOR,
};

/**
 * Helper to query files for a warm graph and attach question completeness (AC-ARCH-01-01).
 */
export function queryGraphFiles(db, { project, question = 'Q1', perKindCoverage = {} }) {
    if (!project) {
        throw new Error('project is required (INV-GR-03)');
    }

    const sql = `
        SELECT id, project, kind, name, path, metadata_json, created_at, updated_at
        FROM graph_node
        WHERE project = ? AND kind = 'file'
        ORDER BY path ASC, name ASC
    `;

    const files = db.all(sql, [project]);
    const completeness = calculateCompleteness(question, perKindCoverage);

    return {
        project,
        question,
        files,
        completeness,
    };
}
