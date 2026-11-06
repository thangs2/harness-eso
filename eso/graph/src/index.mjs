/**
 * @mu/eso-graph — ESO Graph Architecture Domain (Slice S1 / ESO-447)
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
} from './q2-impact.mjs';
import {
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
} from './q3-cycles.mjs';
import {
    queryEndpointPermissions,
} from './q4-permissions.mjs';
import {
    querySliceTenantBoundary,
    TENANT_COVERAGE_FLOOR,
} from './q5-tenant.mjs';
import {
    extractRoslynGraph,
    indexGraphApi28,
    persistGraphResult,
} from './roslyn-adapter.mjs';
import {
    GRAPH_QUESTIONS,
    DEFAULT_GRAPH_FLOOR,
    graphFloor,
    hashGraphSource,
    readIndexRun,
    indexGraph,
    rebuildGraph,
    answerGraphQuestion,
    answerDocsGraph,
    DOCS_NODE_KINDS,
    DOC_RELATIONS,
} from './graph-store.mjs';

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
    extractRoslynGraph,
    indexGraphApi28,
    persistGraphResult,
    GRAPH_QUESTIONS,
    DEFAULT_GRAPH_FLOOR,
    graphFloor,
    hashGraphSource,
    readIndexRun,
    indexGraph,
    rebuildGraph,
    answerGraphQuestion,
    answerDocsGraph,
    DOCS_NODE_KINDS,
    DOC_RELATIONS,
    queryReadSet,
    DEFAULT_THRESHOLD,
    DEFAULT_FLOOR,
    DEFAULT_MAX_FANOUT,
    ALLOWED_RELATIONS,
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
    queryEndpointPermissions,
    querySliceTenantBoundary,
    TENANT_COVERAGE_FLOOR,
};

/**
 * Helper to query files for a warm graph and attach question completeness (AC-ARCH-01-01).
 * Target schema: graph_node(project, build_id, node_id, kind, node_key, path)
 */
export async function queryGraphFiles(db, { project, question = 'Q1', perKindCoverage = {} }) {
    if (!project) {
        throw new Error('project is required (INV-GR-03)');
    }

    const sql = `
        SELECT node_id AS id, node_id, project, kind, node_key AS name, node_key, path
        FROM graph_node
        WHERE project = ? AND (kind = 'module' OR kind = 'doc' OR kind = 'file')
        ORDER BY path ASC, node_key ASC
    `;

    const files = await db.all(sql, [project]);
    const completeness = calculateCompleteness(question, perKindCoverage);

    return {
        project,
        question,
        files,
        completeness,
    };
}
