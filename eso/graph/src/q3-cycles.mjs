/**
 * @mu/eso-graph — Q3 Circular Dependency Detection (ESO-60 / US-ARCH-04 / Slice S1 / ESO-447)
 *
 * Invariants:
 * - D-92 / D-93 / 26.graph-schema.md: Target PostgreSQL columns:
 *     graph_node(project, build_id, node_id, kind, node_key, path)
 *     graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 *     completeness(project, build_id, question, per_kind, value, measured_at)
 * - INV-GR-01: Circular dependency detection runs Tarjan SCC on real depends_on edges.
 * - INV-GR-02: Completeness calculation based on question K(Q3), floor = 0.70, threshold = 0.90.
 * - BR-05: Khi completeness < floor, từ chối phát biểu không có vòng; trả status: 'unknown' và LOW_COVERAGE.
 * - AC-ARCH-04-01: Phát hiện đúng chu trình thật (SCC).
 * - AC-ARCH-04-02: Kim cương (diamond) không báo chu trình giả.
 * - AC-ARCH-04-04: 0 cạnh depends_on -> nói rõ "không có vòng" kèm completeness.
 * - AC-ARCH-04-05: Cắt tỉa cạnh mồ côi (dangling edge) mà không báo vòng giả.
 */

import { calculateCompleteness } from './completeness.mjs';

export const DEFAULT_THRESHOLD_Q3 = 0.90;
export const DEFAULT_FLOOR_Q3 = 0.70;

function findSCCs(adjMap) {
    let index = 0;
    const indices = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];

    function strongConnect(v) {
        indices.set(v, index);
        lowlink.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);

        const neighbors = adjMap.get(v) || [];
        for (const w of neighbors) {
            if (!indices.has(w)) {
                strongConnect(w);
                lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
            } else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
            }
        }

        if (lowlink.get(v) === indices.get(v)) {
            const scc = [];
            let w;
            do {
                w = stack.pop();
                onStack.delete(w);
                scc.push(w);
            } while (w !== v);

            if (scc.length > 1) {
                sccs.push(scc.reverse());
            } else if (scc.length === 1 && (adjMap.get(scc[0]) || []).includes(scc[0])) {
                sccs.push(scc);
            }
        }
    }

    for (const node of adjMap.keys()) {
        if (!indices.has(node)) {
            strongConnect(node);
        }
    }

    return sccs;
}

/**
 * Query circular dependencies (Q3)
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {number|object} [params.completeness] Explicit completeness
 * @param {number} [params.threshold=0.90]
 * @param {number} [params.floor=0.70]
 * @param {string} [params.buildId=null]
 * @returns {Promise<object>} Query result
 */
export async function queryCircularDependencies(db, {
    project,
    completeness,
    threshold = DEFAULT_THRESHOLD_Q3,
    floor = DEFAULT_FLOOR_Q3,
    buildId = null,
} = {}) {
    const normProject = (project || '').trim();

    if (!normProject) {
        return {
            status: 'REFUSED',
            error: 'MISSING_INPUT',
            project: normProject,
            hasCycles: false,
            cycles: [],
            unknowns: [],
        };
    }

    // 1. Evaluate Completeness (INV-GR-02 & BR-05)
    let compVal = null;
    let completenessObj = null;

    if (typeof completeness === 'number') {
        compVal = completeness;
        completenessObj = {
            question: 'Q3',
            value: compVal,
            status: compVal >= threshold ? 'ready' : 'unknown',
        };
    } else if (completeness && typeof completeness.value === 'number') {
        compVal = completeness.value;
        completenessObj = completeness;
    } else if (db && typeof db.all === 'function') {
        try {
            const rows = await db.all(
                "SELECT value FROM completeness WHERE project = ?" + (buildId ? " AND build_id = ?" : "") + " AND question = 'Q3' ORDER BY measured_at DESC LIMIT 1",
                buildId ? [normProject, buildId] : [normProject]
            );
            if (rows && rows.length > 0 && typeof rows[0].value === 'number') {
                compVal = rows[0].value;
                completenessObj = { question: 'Q3', value: compVal, status: compVal >= threshold ? 'ready' : 'unknown' };
            }
        } catch {}
    }

    // Refusal when coverage is below floor (0.70)
    if (compVal === null || compVal === undefined || compVal < floor) {
        return {
            status: 'unknown',
            error: 'LOW_COVERAGE',
            project: normProject,
            coverage: compVal !== null && compVal !== undefined ? compVal : 0,
            threshold,
            floor,
            hasCycles: false,
            cycles: [],
            unknowns: [],
            message: 'Coverage below floor; cannot guarantee acyclicity',
        };
    }

    const isUnknown = compVal < threshold;
    const unknowns = [];

    // 2. Fetch all module / package nodes for this project (target columns: node_id, node_key, path)
    const allNodes = await db.all(
        `SELECT node_id AS id, node_id, project, kind, node_key AS name, node_key, path
         FROM graph_node
         WHERE project = ?` + (buildId ? ' AND build_id = ?' : ''),
        buildId ? [normProject, buildId] : [normProject]
    );

    const nodeMap = new Map();
    for (const n of allNodes) {
        nodeMap.set(n.node_id, n);
        nodeMap.set(n.node_key, n);
    }

    // 3. Fetch all depends_on edges (target columns: edge_id, from_node_id, to_node_id, kind)
    const allEdges = await db.all(
        `SELECT edge_id AS id, edge_id, project, from_node_id AS source_id, from_node_id, to_node_id AS target_id, to_node_id, kind AS relation, kind
         FROM graph_edge
         WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + ` AND kind = 'depends_on'`,
        buildId ? [normProject, buildId] : [normProject]
    );

    // AC-ARCH-04-04: Graph with 0 depends_on edges -> "không có vòng" kèm độ phủ, không im lặng
    if (allEdges.length === 0) {
        return {
            status: isUnknown ? 'unknown' : 'ready',
            error: isUnknown ? 'LOW_COVERAGE' : null,
            project: normProject,
            hasCycles: false,
            cycles: [],
            totalEdgesChecked: 0,
            coverage: compVal,
            threshold,
            floor,
            unknowns,
            message: 'không có vòng (no cycles detected)',
        };
    }

    // 4. Build adjacency graph, filtering out dangling module edges (AC-ARCH-04-05 & ED10)
    const adjMap = new Map();

    for (const [id, node] of nodeMap.entries()) {
        if (['module', 'package', 'file'].includes(node.kind)) {
            adjMap.set(node.name || id, []);
        }
    }

    let validEdgesCount = 0;

    for (const edge of allEdges) {
        const sourceNode = nodeMap.get(edge.from_node_id);
        const targetNode = nodeMap.get(edge.to_node_id);

        if (!sourceNode || !targetNode) {
            unknowns.push({
                type: 'DANGLING_MODULE',
                edgeId: edge.edge_id,
                sourceModule: sourceNode?.name || edge.from_node_id,
                targetModule: targetNode?.name || edge.to_node_id,
                message: `Dangling depends_on edge pruned: ${edge.from_node_id} -> ${edge.to_node_id}`,
            });
            continue;
        }

        const srcName = sourceNode.name || sourceNode.node_id;
        const tgtName = targetNode.name || targetNode.node_id;

        if (!adjMap.has(srcName)) adjMap.set(srcName, []);
        if (!adjMap.has(tgtName)) adjMap.set(tgtName, []);

        adjMap.get(srcName).push(tgtName);
        validEdgesCount++;
    }

    // 5. Run Tarjan's SCC cycle detector
    const sccs = findSCCs(adjMap);
    const hasCycles = sccs.length > 0;

    return {
        status: isUnknown ? 'unknown' : 'ready',
        error: isUnknown ? 'LOW_COVERAGE' : null,
        project: normProject,
        hasCycles,
        cycles: sccs,
        totalEdgesChecked: validEdgesCount,
        coverage: compVal,
        threshold,
        floor,
        unknowns,
        message: hasCycles
            ? `phát hiện ${sccs.length} chu trình phụ thuộc vòng (detected ${sccs.length} circular dependencies)`
            : 'không có vòng (no cycles detected)',
    };
}
