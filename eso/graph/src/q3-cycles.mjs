/**
 * @mu/eso-graph — Q3 Circular Dependency Query Implementation (ESO-60 / US-ARCH-04 / Slice S1)
 *
 * Invariants:
 * - INV-GR-01: Không bịa cạnh, chỉ duyệt theo quan hệ thật trong graph_edge (depends_on).
 * - INV-GR-02: Completeness theo câu hỏi K(Q3) = [module, package], threshold >= floor (threshold = 0.90, floor = 0.70).
 * - INV-GR-03 / BR-05: Khi completeness < threshold (hoặc < 0.70), cấm kết luận "sạch" / không vòng; phải trả status: 'unknown'.
 * - AC-ARCH-04-01: Happy path: Liệt kê SCC thật (chu trình lặp).
 * - AC-ARCH-04-02: Edge: Diamond / dependency chung không báo vòng giả (0 false positive).
 * - AC-ARCH-04-03: Failure: coverage < 0.70 -> unknown + LOW_COVERAGE, không khẳng định "sạch".
 * - AC-ARCH-04-04: Edge: Graph 0 cạnh depends_on -> trả lời "không có vòng" kèm độ phủ, không im lặng.
 * - AC-ARCH-04-05: Edge: Cạnh depends_on trỏ module đã xóa -> bỏ cạnh treo, unknowns có mục DANGLING_MODULE, không báo vòng giả.
 */

import { calculateCompleteness } from './completeness.mjs';

export const DEFAULT_THRESHOLD_Q3 = 0.90;
export const DEFAULT_FLOOR_Q3 = 0.70;
export const ALLOWED_RELATIONS_Q3 = ['depends_on'];

/**
 * Tarjan's SCC algorithm to detect all strongly connected components with size >= 2 (or self loops).
 *
 * @param {Map<string, Array<string>>} adjMap Adjacency list: node -> outgoing neighbors
 * @returns {Array<Array<string>>} List of cycles/SCCs with size >= 2 (or self loop)
 */
function findSCCs(adjMap) {
    let index = 0;
    const stack = [];
    const inStack = new Set();
    const indices = new Map();
    const lowlinks = new Map();
    const sccs = [];

    function strongConnect(v) {
        indices.set(v, index);
        lowlinks.set(v, index);
        index++;
        stack.push(v);
        inStack.add(v);

        const neighbors = adjMap.get(v) || [];
        for (const w of neighbors) {
            if (!indices.has(w)) {
                strongConnect(w);
                lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
            } else if (inStack.has(w)) {
                lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
            }
        }

        if (lowlinks.get(v) === indices.get(v)) {
            const scc = [];
            let w;
            do {
                w = stack.pop();
                inStack.delete(w);
                scc.push(w);
            } while (w !== v);

            // A cycle is an SCC with > 1 node, or a single node with a self-loop
            if (scc.length > 1) {
                sccs.push(scc);
            } else if (scc.length === 1) {
                const selfNode = scc[0];
                if ((adjMap.get(selfNode) || []).includes(selfNode)) {
                    sccs.push(scc);
                }
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
 * @param {object} db Database handle (exec, all, run, get)
 * @param {object} params
 * @param {string} params.project Project identifier (INV-GR-03)
 * @param {number|object} [params.completeness] Explicit completeness or overrides
 * @param {number} [params.threshold] Minimum threshold (defaults to 0.90)
 * @param {number} [params.floor] Refusal floor (defaults to 0.70 per AC-ARCH-04-03)
 * @param {string} [params.buildId] Optional build identifier
 * @returns {object} Query result
 */
export function queryCircularDependencies(db, {
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
    } else {
        const computed = calculateCompleteness(db, normProject, 'Q3');
        compVal = computed.value;
        completenessObj = computed;
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

    // 2. Fetch all module / package nodes for this project
    const allNodes = db.all(
        `SELECT id, project, kind, name, path, metadata_json
         FROM graph_node
         WHERE project = ?`,
        [normProject]
    );

    const nodeMap = new Map();
    for (const n of allNodes) {
        nodeMap.set(n.id, n);
    }

    // 3. Fetch all depends_on edges
    const allEdges = db.all(
        `SELECT id, project, source_id, target_id, relation, metadata_json
         FROM graph_edge
         WHERE project = ? AND relation = 'depends_on'`,
        [normProject]
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

    // Ensure all relevant nodes exist in adjMap
    for (const [id, node] of nodeMap.entries()) {
        if (['module', 'package', 'file'].includes(node.kind)) {
            adjMap.set(node.name || id, []);
        }
    }

    let validEdgesCount = 0;

    for (const edge of allEdges) {
        const sourceNode = nodeMap.get(edge.source_id);
        const targetNode = nodeMap.get(edge.target_id);

        // Check if target node or source node is missing or marked deleted (AC-ARCH-04-05)
        const isTargetDeleted = !targetNode || (targetNode.metadata_json && targetNode.metadata_json.includes('"deleted":true'));
        const isSourceDeleted = !sourceNode || (sourceNode.metadata_json && sourceNode.metadata_json.includes('"deleted":true'));

        if (isTargetDeleted || isSourceDeleted) {
            unknowns.push({
                type: 'DANGLING_MODULE',
                edgeId: edge.id,
                sourceModule: sourceNode?.name || edge.source_id,
                targetModule: targetNode?.name || edge.target_id,
                message: `Dangling depends_on edge pruned: ${edge.source_id} -> ${edge.target_id}`,
            });
            continue; // Prune dangling edge: do not add to graph, avoiding false positive cycles
        }

        const srcName = sourceNode.name || sourceNode.id;
        const tgtName = targetNode.name || targetNode.id;

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
