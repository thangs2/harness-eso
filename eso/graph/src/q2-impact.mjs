/**
 * @mu/eso-graph — Q2 Column Impact Query (ESO-55 / US-ARCH-03 / Slice S1 / ESO-447)
 *
 * Invariants:
 * - D-92 / D-93 / 26.graph-schema.md: Target PostgreSQL columns:
 *     graph_node(project, build_id, node_id, kind, node_key, path)
 *     graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 *     source_claim(project, build_id, edge_id, seq, source_kind, claim, at)
 *     completeness(project, build_id, question, per_kind, value, measured_at)
 * - INV-GR-01: Reverse-dependency impact chain strictly: entity -> dto -> app_service.
 * - INV-GR-02: Completeness tính theo K(Q2), floor = 0.80, threshold = 0.90.
 * - BR-05: Khi completeness < threshold (nhưng >= floor), trả status: 'unknown' và LOW_COVERAGE, cấm "không gãy gì".
 * - AC-ARCH-03-03: Kiểm tra candidates; nếu chứa file không phụ thuộc table -> từ chối với OVERREACH.
 * - AC-ARCH-03-04: Bảng không ai đọc -> danh sách rỗng, 0 file bịa.
 * - AC-ARCH-03-05: Entity trỏ tới bảng đã xoá -> trả unknown + DANGLING_TABLE.
 */

import { calculateCompleteness } from './completeness.mjs';

export const DEFAULT_THRESHOLD_Q2 = 0.90;
export const DEFAULT_FLOOR_Q2 = 0.80;

/**
 * Query column impact for Q2: "đổi cột bảng thì cái gì gãy"
 *
 * @param {object} db - Database adapter instance
 * @param {object} options
 * @param {string} options.project - Project identifier (required)
 * @param {string} options.table - Target table name (required)
 * @param {string} [options.column=null] - Column being modified
 * @param {Array<string>} [options.candidates=null] - Candidate files to validate
 * @param {number|object} [options.completeness=null] - Completeness override
 * @param {number} [options.threshold=0.90] - Target threshold
 * @param {number} [options.floor=0.80] - Refusal floor
 * @param {string} [options.buildId=null] - Build identifier
 * @returns {Promise<object>}
 */
export async function queryColumnImpact(db, options = {}) {
    const {
        project,
        table,
        column = null,
        candidates = null,
        completeness = null,
        buildId = null,
        threshold = DEFAULT_THRESHOLD_Q2,
        floor = DEFAULT_FLOOR_Q2,
    } = options;

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
    } else if (db && typeof db.all === 'function') {
        try {
            const rows = await db.all(
                "SELECT value FROM completeness WHERE project = ?" + (buildId ? " AND build_id = ?" : "") + " AND question = 'Q2' ORDER BY measured_at DESC LIMIT 1",
                buildId ? [normProject, buildId] : [normProject]
            );
            if (rows && rows.length > 0 && typeof rows[0].value === 'number') {
                compVal = rows[0].value;
                completenessObj = { question: 'Q2', value: compVal, status: compVal >= threshold ? 'ready' : 'unknown' };
            }
        } catch {}
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

    // 2. Locate Table Node in Graph (target columns: node_id, node_key, path)
    const tableNodes = await db.all(
        `SELECT node_id AS id, node_id, project, kind, node_key AS name, path
         FROM graph_node
         WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + ` AND (node_key = ? OR path = ?) AND kind = 'table'`,
        buildId ? [normProject, buildId, normTable, normTable] : [normProject, normTable, normTable]
    );

    // AC-ARCH-03-05: Check for entities referencing a deleted or missing table
    // 1. Via source_claim
    const danglingClaims = await db.all(
        `SELECT c.edge_id, c.claim
         FROM source_claim c
         WHERE c.project = ?` + (buildId ? ' AND c.build_id = ?' : '') + ` AND c.claim LIKE ?`,
        buildId ? [normProject, buildId, `%"${normTable}"%`] : [normProject, `%"${normTable}"%`]
    );

    // 2. Via graph_edge if table is absent
    let danglingEdges = [];
    if (tableNodes.length === 0) {
        danglingEdges = await db.all(
            `SELECT e.edge_id, e.from_node_id, n.node_key AS entity_name, n.path AS entity_path
             FROM graph_edge e
             JOIN graph_node n ON e.from_node_id = n.node_id AND n.project = ?` + (buildId ? ' AND e.build_id = n.build_id' : '') + `
             WHERE e.project = ?` + (buildId ? ' AND e.build_id = ?' : '') + ` AND (e.to_node_id = ? OR e.to_node_id LIKE ?) AND e.kind = 'maps_to'`,
            buildId ? [normProject, normProject, buildId, normTable, `%${normTable}%`] : [normProject, normProject, normTable, `%${normTable}%`]
        );
    }

    const referencingNames = new Set([
        ...danglingClaims.map((c) => normTable),
        ...danglingEdges.map((e) => e.entity_name),
    ]);

    if (tableNodes.length === 0) {
        if (referencingNames.size > 0 || danglingClaims.length > 0) {
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

        // Table simply not found and not referenced
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
    // Step 3a: table <- entity (via maps_to or references or defines)
    const entityEdges = await db.all(
        `SELECT e.from_node_id AS source_id, n.node_id AS id, n.kind, n.node_key AS name, n.path
         FROM graph_edge e
         JOIN graph_node n ON e.from_node_id = n.node_id AND n.project = ?` + (buildId ? ' AND e.build_id = n.build_id' : '') + `
         WHERE e.project = ?` + (buildId ? ' AND e.build_id = ?' : '') + ` AND e.to_node_id = ? AND e.kind IN ('maps_to', 'references', 'defines')
           AND n.kind = 'entity'`,
        buildId ? [normProject, normProject, buildId, tableNode.node_id] : [normProject, normProject, tableNode.node_id]
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
        const dtoEdges = await db.all(
            `SELECT e.from_node_id AS source_id, n.node_id AS id, n.kind, n.node_key AS name, n.path
             FROM graph_edge e
             JOIN graph_node n ON e.from_node_id = n.node_id AND n.project = ?` + (buildId ? ' AND e.build_id = n.build_id' : '') + `
             WHERE e.project = ?` + (buildId ? ' AND e.build_id = ?' : '') + ` AND e.to_node_id IN (${entityPlaceholders}) AND e.kind IN ('references', 'maps_to')
               AND n.kind = 'dto'`,
            buildId ? [normProject, normProject, buildId, ...entityIds] : [normProject, normProject, ...entityIds]
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
    const nextHopIds = [...dtoIds, ...entityIds];

    if (nextHopIds.length > 0) {
        const hopPlaceholders = nextHopIds.map(() => '?').join(',');
        const serviceEdges = await db.all(
            `SELECT e.from_node_id AS source_id, n.node_id AS id, n.kind, n.node_key AS name, n.path
             FROM graph_edge e
             JOIN graph_node n ON e.from_node_id = n.node_id AND n.project = ?` + (buildId ? ' AND e.build_id = n.build_id' : '') + `
             WHERE e.project = ?` + (buildId ? ' AND e.build_id = ?' : '') + ` AND e.to_node_id IN (${hopPlaceholders}) AND e.kind IN ('references')
               AND n.kind IN ('app_service', 'service')`,
            buildId ? [normProject, normProject, buildId, ...nextHopIds] : [normProject, normProject, ...nextHopIds]
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
