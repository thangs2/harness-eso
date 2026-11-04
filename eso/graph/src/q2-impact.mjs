/**
 * @mu/eso-graph — Q2 Column Impact Query Implementation (ESO-55 / US-ARCH-03 / Slice S1)
 *
 * Invariants:
 * - INV-GR-01: Không bịa cạnh, chỉ duyệt theo quan hệ thật trong graph_edge (maps_to, references, declares).
 *   Traversal ngược chiều: table -> entity -> dto -> app_service. 0 chiều xuôi.
 * - INV-GR-02: Completeness theo câu hỏi K(Q2) = [table, entity, column], threshold >= floor.
 * - INV-GR-03 / BR-05: Khi completeness < threshold, cấm kết luận "không gãy gì" (absent); phải trả status: 'unknown'.
 * - AC-ARCH-03-01: Happy path: chuỗi ngược chiều entity -> dto -> app_service.
 * - AC-ARCH-03-02: Edge: coverage thấp -> unknown, error: 'LOW_COVERAGE'.
 * - AC-ARCH-03-03: Failure: Cấm liệt kê file thừa không dùng bảng; thừa là OVERREACH -> từ chối.
 * - AC-ARCH-03-04: Edge: Bảng không ai đọc -> danh sách rỗng, không OVERREACH.
 * - AC-ARCH-03-05: Edge: Entity trỏ bảng đã xóa / không tồn tại -> unknowns có mục DANGLING_TABLE, status: 'unknown'.
 */

import { calculateCompleteness } from './completeness.mjs';

export const DEFAULT_THRESHOLD_Q2 = 0.90;
export const DEFAULT_FLOOR_Q2 = 0.80;
export const ALLOWED_RELATIONS_Q2 = ['maps_to', 'references', 'declares'];

/**
 * Query column impact (Q2)
 *
 * @param {object} db Database handle (exec, all, run, get)
 * @param {object} params
 * @param {string} params.project Project identifier (INV-GR-03)
 * @param {string} params.table Table name to analyze
 * @param {string} [params.column] Specific column name (optional)
 * @param {number|object} [params.completeness] Explicit completeness or overrides
 * @param {number} [params.threshold] Minimum threshold (defaults to 0.90)
 * @param {number} [params.floor] Refusal floor (defaults to 0.80)
 * @param {string} [params.buildId] Optional build identifier
 * @param {Array<string>} [params.candidates] If provided, validates against candidate list to check for OVERREACH (AC-ARCH-03-03)
 * @returns {object} Query result
 */
export function queryColumnImpact(db, {
    project,
    table,
    column,
    completeness,
    threshold = DEFAULT_THRESHOLD_Q2,
    floor = DEFAULT_FLOOR_Q2,
    buildId = null,
    candidates = null,
} = {}) {
    const normProject = (project || '').trim();
    const normTable = (table || '').trim();

    // AC-ARCH-03-03 / Refusal: Project and Table are strictly required
    if (!normProject || !normTable) {
        return {
            status: 'REFUSED',
            error: 'MISSING_INPUT',
            project: normProject,
            table: normTable,
            column: column || null,
            impactChain: [],
            impactedFiles: [],
            unknowns: [],
        };
    }

    // 1. Evaluate Completeness (INV-GR-02 & BR-05)
    let compVal = null;
    let completenessObj = null;

    if (typeof completeness === 'number') {
        compVal = completeness;
        completenessObj = {
            question: 'Q2',
            value: compVal,
            status: compVal >= threshold ? 'ready' : 'unknown',
        };
    } else if (completeness && typeof completeness.value === 'number') {
        compVal = completeness.value;
        completenessObj = completeness;
    } else {
        const computed = calculateCompleteness(db, normProject, 'Q2');
        compVal = computed.value;
        completenessObj = computed;
    }

    // Refusal when coverage is null or below floor
    if (compVal === null || compVal === undefined || compVal < floor) {
        return {
            status: 'REFUSED',
            error: 'LOW_COVERAGE',
            project: normProject,
            table: normTable,
            column: column || null,
            coverage: compVal !== null && compVal !== undefined ? compVal : 0,
            threshold,
            floor,
            impactChain: [],
            impactedFiles: [],
            unknowns: [],
        };
    }

    const isUnknown = compVal < threshold;
    const unknowns = [];

    // 2. Locate Table Node in Graph
    const tableNodes = db.all(
        `SELECT id, project, kind, name, path, metadata_json
         FROM graph_node
         WHERE project = ? AND (name = ? OR path = ?) AND kind = 'table'`,
        [normProject, normTable, normTable]
    );

    // Check if table node is marked as deleted (AC-ARCH-03-05)
    let isTableDeleted = false;
    if (tableNodes.length > 0) {
        const meta = tableNodes[0].metadata_json;
        if (meta && (meta.includes('"deleted":true') || meta.includes('"status":"deleted"'))) {
            isTableDeleted = true;
        }
    }

    // AC-ARCH-03-05: Check for entities referencing a deleted or missing table
    // 1. Via source_claim
    const danglingClaims = db.all(
        `SELECT c.id, c.node_id, n.name AS entity_name, n.path AS entity_path
         FROM source_claim c
         JOIN graph_node n ON c.node_id = n.id AND n.project = ?
         WHERE c.project = ? AND c.claim_payload LIKE ?`,
        [normProject, normProject, `%"${normTable}"%`]
    );

    // 2. Via entity metadata_json
    const danglingEntities = db.all(
        `SELECT id, name, path
         FROM graph_node
         WHERE project = ? AND kind = 'entity' AND metadata_json LIKE ?`,
        [normProject, `%"${normTable}"%`]
    );

    // 3. Via graph_edge if table was soft-deleted or exists
    let danglingEdges = [];
    if (tableNodes.length > 0 && isTableDeleted) {
        danglingEdges = db.all(
            `SELECT e.id, e.source_id, n.name AS entity_name, n.path AS entity_path
             FROM graph_edge e
             JOIN graph_node n ON e.source_id = n.id AND n.project = ?
             WHERE e.project = ? AND e.target_id = ? AND e.relation = 'maps_to'`,
            [normProject, normProject, tableNodes[0].id]
        );
    }

    const referencingNames = new Set([
        ...danglingClaims.map((c) => c.entity_name),
        ...danglingEntities.map((e) => e.name),
        ...danglingEdges.map((e) => e.entity_name),
    ]);

    if (tableNodes.length === 0 || isTableDeleted) {
        if (referencingNames.size > 0) {
            // AC-ARCH-03-05: Dangling table reference detected
            unknowns.push({
                type: 'DANGLING_TABLE',
                table: normTable,
                message: `Table '${normTable}' is referenced by entities but table definition is deleted or missing`,
                referencingEntities: Array.from(referencingNames),
            });
            return {
                status: 'unknown',
                error: 'DANGLING_TABLE',
                project: normProject,
                table: normTable,
                column: column || null,
                coverage: compVal,
                threshold,
                floor,
                impactChain: [],
                impactedFiles: [],
                unknowns,
            };
        }

        // Table simply not found and not referenced by anything
        return {
            status: isUnknown ? 'unknown' : 'ready',
            project: normProject,
            table: normTable,
            column: column || null,
            coverage: compVal,
            threshold,
            floor,
            impactChain: [],
            impactedFiles: [],
            unknowns,
        };
    }

    const tableNode = tableNodes[0];

    // 3. Reverse Traversal: table -> entity -> dto -> app_service (AC-ARCH-03-01 & INV-GR-01)
    // Step 3a: table <- entity (via maps_to or declares or references)
    const entityEdges = db.all(
        `SELECT e.source_id, n.id, n.kind, n.name, n.path
         FROM graph_edge e
         JOIN graph_node n ON e.source_id = n.id AND n.project = ?
         WHERE e.project = ? AND e.target_id = ? AND e.relation IN ('maps_to', 'references', 'declares')
           AND n.kind = 'entity'`,
        [normProject, normProject, tableNode.id]
    );

    // AC-ARCH-03-04: If no entity or consumer reads this table -> empty list, ready
    if (entityEdges.length === 0) {
        return {
            status: isUnknown ? 'unknown' : 'ready',
            project: normProject,
            table: normTable,
            column: column || null,
            coverage: compVal,
            threshold,
            floor,
            impactChain: [],
            impactedFiles: [],
            unknowns,
        };
    }

    const entities = [];
    const entityIds = [];
    const impactedFilesSet = new Set();

    for (const row of entityEdges) {
        entities.push({
            id: row.id,
            kind: row.kind,
            name: row.name,
            path: row.path,
        });
        entityIds.push(row.id);
        if (row.path) impactedFilesSet.add(row.path.replace(/\\/g, '/'));
    }

    // Step 3b: entity <- dto (via references or maps_to)
    const dtos = [];
    const dtoIds = [];

    if (entityIds.length > 0) {
        const entityPlaceholders = entityIds.map(() => '?').join(',');
        const dtoEdges = db.all(
            `SELECT e.source_id, n.id, n.kind, n.name, n.path
             FROM graph_edge e
             JOIN graph_node n ON e.source_id = n.id AND n.project = ?
             WHERE e.project = ? AND e.target_id IN (${entityPlaceholders}) AND e.relation IN ('references', 'maps_to')
               AND n.kind = 'dto'`,
            [normProject, normProject, ...entityIds]
        );

        for (const row of dtoEdges) {
            dtos.push({
                id: row.id,
                kind: row.kind,
                name: row.name,
                path: row.path,
            });
            dtoIds.push(row.id);
            if (row.path) impactedFilesSet.add(row.path.replace(/\\/g, '/'));
        }
    }

    // Step 3c: dto <- app_service (via references)
    const appServices = [];
    const nextHopIds = [...dtoIds, ...entityIds]; // Services might reference DTO or Entity directly

    if (nextHopIds.length > 0) {
        const hopPlaceholders = nextHopIds.map(() => '?').join(',');
        const serviceEdges = db.all(
            `SELECT e.source_id, n.id, n.kind, n.name, n.path
             FROM graph_edge e
             JOIN graph_node n ON e.source_id = n.id AND n.project = ?
             WHERE e.project = ? AND e.target_id IN (${hopPlaceholders}) AND e.relation IN ('references')
               AND n.kind IN ('app_service', 'service')`,
            [normProject, normProject, ...nextHopIds]
        );

        for (const row of serviceEdges) {
            appServices.push({
                id: row.id,
                kind: row.kind,
                name: row.name,
                path: row.path,
            });
            if (row.path) impactedFilesSet.add(row.path.replace(/\\/g, '/'));
        }
    }

    const impactedFiles = Array.from(impactedFilesSet);

    // AC-ARCH-03-03: Validate candidates if supplied (Detect OVERREACH)
    if (Array.isArray(candidates)) {
        const normCandidates = candidates.map((c) => c.replace(/\\/g, '/').trim());
        const invalidCandidates = normCandidates.filter((c) => !impactedFilesSet.has(c));
        if (invalidCandidates.length > 0) {
            return {
                status: 'REFUSED',
                error: 'OVERREACH',
                message: 'Candidates contain files not depending on table: ' + invalidCandidates.join(', '),
                project: normProject,
                table: normTable,
                invalidFiles: invalidCandidates,
                impactChain: [],
                impactedFiles: [],
                unknowns,
            };
        }
    }

    // Return reverse-chain: entity -> dto -> app_service
    const impactChain = [
        ...entities.map((e) => ({ ...e, step: 1, role: 'entity' })),
        ...dtos.map((d) => ({ ...d, step: 2, role: 'dto' })),
        ...appServices.map((s) => ({ ...s, step: 3, role: 'app_service' })),
    ];

    return {
        status: isUnknown ? 'unknown' : 'ready',
        error: isUnknown ? 'LOW_COVERAGE' : null,
        project: normProject,
        table: normTable,
        column: column || null,
        coverage: compVal,
        threshold,
        floor,
        impactChain,
        impactedFiles,
        unknowns,
    };
}
