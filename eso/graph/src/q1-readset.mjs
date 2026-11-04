/**
 * @mu/eso-graph — Q1 Read-Set Query Implementation (ESO-50 / US-ARCH-02 / Slice S1)
 *
 * Invariants:
 * - INV-GR-01: Không bịa cạnh, chỉ duyệt theo quan hệ thật trong graph_edge (references, maps_to, declares).
 * - INV-GR-02: Completeness tính theo câu hỏi (K(Q1)), threshold >= floor (mặc định threshold = 0.90, floor = 0.80).
 * - INV-GR-03 / BR-05: Khi completeness < threshold, cấm kết luận absent hoặc trả [], phải trả status: 'unknown' kèm độ phủ.
 * - Fanout cap: khi kết quả vượt maxFanout (mặc định 50), trả về danh sách bị chặn trần, kèm capped: true và totalFound thực tế.
 *
 * Acceptance Criteria:
 * - AC-ARCH-02-01: danh sách file, độ sâu <= 2.
 * - AC-ARCH-02-02: unknown + độ phủ khi completeness < threshold.
 * - AC-ARCH-02-03: từ chối trả lời (status: 'REFUSED', error: 'NO_COVERAGE') khi không có độ phủ hoặc input thiếu.
 * - AC-ARCH-02-04: read set rỗng, không lỗi khi symbol cô lập 0 tham chiếu (status: 'ready', readSet: []).
 * - AC-ARCH-02-05: danh sách bị chặn trần (capped: true, totalFound: N, readSet.length == maxFanout) khi vượt ngưỡng fanout.
 */

import { calculateCompleteness } from './completeness.mjs';

export const DEFAULT_THRESHOLD = 0.90;
export const DEFAULT_FLOOR = 0.80;
export const DEFAULT_MAX_FANOUT = 50;
export const ALLOWED_RELATIONS = Object.freeze(['references', 'maps_to', 'declares']);

/**
 * Query read-set for Q1: "sửa X thì phải đọc file nào"
 *
 * @param {object} db - Database instance supporting .all() and .get()
 * @param {object} options
 * @param {string} options.project - Project identifier (required)
 * @param {string} options.symbolOrFile - Target symbol or file path to analyze (required)
 * @param {string} [options.buildId=null] - Build / commit identifier
 * @param {number} [options.threshold=0.90] - Target completeness threshold
 * @param {number} [options.floor=0.80] - Minimum completeness floor
 * @param {number} [options.maxFanout=50] - Maximum fanout cap
 * @param {number|object} [options.completeness=null] - Completeness value or object
 * @returns {object}
 */
export function queryReadSet(db, options = {}) {
    const {
        project,
        symbolOrFile,
        buildId = null,
        threshold = DEFAULT_THRESHOLD,
        floor = DEFAULT_FLOOR,
        maxFanout = DEFAULT_MAX_FANOUT,
        completeness = null,
    } = options;

    // AC-ARCH-02-03: từ chối trả lời khi input thiếu
    if (!project || typeof project !== 'string' || !project.trim() ||
        !symbolOrFile || typeof symbolOrFile !== 'string' || !symbolOrFile.trim()) {
        return {
            status: 'REFUSED',
            error: 'NO_COVERAGE',
            message: 'project and symbolOrFile are required (AC-ARCH-02-03)',
            project: project ? project.trim() : null,
            symbolOrFile: symbolOrFile ? symbolOrFile.trim() : null,
            buildId: buildId || null,
            readSet: [],
            totalFound: 0,
            capped: false,
            depth: 0,
            coverage: 0,
            completeness: null,
        };
    }

    const normProject = project.trim();
    const normTarget = symbolOrFile.trim().replace(/\\/g, '/');

    // Threshold & floor validation (INV-GR-02: threshold >= floor)
    const effFloor = typeof floor === 'number' && Number.isFinite(floor) ? floor : DEFAULT_FLOOR;
    const effThreshold = typeof threshold === 'number' && Number.isFinite(threshold)
        ? Math.max(threshold, effFloor)
        : Math.max(DEFAULT_THRESHOLD, effFloor);
    const effMaxFanout = typeof maxFanout === 'number' && Number.isFinite(maxFanout) && maxFanout > 0
        ? Math.floor(maxFanout)
        : DEFAULT_MAX_FANOUT;

    // Resolve completeness (AC-ARCH-02-03)
    let compVal = null;
    if (typeof completeness === 'number' && Number.isFinite(completeness)) {
        compVal = Math.max(0, Math.min(1, completeness));
    } else if (completeness && typeof completeness === 'object') {
        if (typeof completeness.value === 'number') {
            compVal = Math.max(0, Math.min(1, completeness.value));
        } else if (typeof completeness.coverage === 'number') {
            compVal = Math.max(0, Math.min(1, completeness.coverage));
        } else if (completeness.perKindCoverage || completeness.perKind) {
            const calculated = calculateCompleteness('Q1', completeness.perKindCoverage || completeness.perKind);
            compVal = calculated.value;
        }
    }

    // If not provided in options, attempt to read from database completeness table
    if (compVal === null && db && typeof db.all === 'function') {
        try {
            const rows = db.all(
                "SELECT value, status FROM completeness WHERE project = ? AND question_id = 'Q1' ORDER BY calculated_at DESC LIMIT 1",
                [normProject]
            );
            if (rows && rows.length > 0 && typeof rows[0].value === 'number') {
                compVal = Math.max(0, Math.min(1, rows[0].value));
            }
        } catch {
            // DB table might not have records or error querying
        }
    }

    // AC-ARCH-02-03: từ chối trả lời (status: 'REFUSED', error: 'NO_COVERAGE') khi không có độ phủ hoặc completeness < floor
    if (compVal === null || compVal === 0 || compVal < effFloor) {
        return {
            status: 'REFUSED',
            error: 'NO_COVERAGE',
            message: compVal === null
                ? 'No coverage data available (AC-ARCH-02-03)'
                : `Completeness ${compVal} is below floor ${effFloor} (AC-ARCH-02-03)`,
            project: normProject,
            symbolOrFile: normTarget,
            buildId: buildId || null,
            readSet: [],
            totalFound: 0,
            capped: false,
            depth: 0,
            coverage: compVal !== null ? compVal : 0,
            completeness: compVal !== null ? { value: compVal, status: 'unknown', coverage: compVal } : null,
        };
    }

    // Completeness status determination
    // AC-ARCH-02-02 & INV-GR-03 / BR-05: unknown + độ phủ khi completeness < threshold
    const isUnknown = compVal < effThreshold;
    const completenessObj = {
        question: 'Q1',
        value: compVal,
        status: isUnknown ? 'unknown' : 'ready',
        coverage: compVal,
    };

    if (!db || typeof db.all !== 'function') {
        return {
            status: isUnknown ? 'unknown' : 'ready',
            project: normProject,
            symbolOrFile: normTarget,
            buildId: buildId || null,
            readSet: [],
            totalFound: 0,
            capped: false,
            depth: 0,
            coverage: compVal,
            completeness: completenessObj,
        };
    }

    // 1. Find initial nodes matching target symbol or file (INV-GR-01, INV-GR-03)
    const strippedTarget = normTarget.replace(/^\.\//, '');
    const startNodes = db.all(
        `SELECT id, project, kind, name, path
         FROM graph_node
         WHERE project = ? AND (
             id = ? OR name = ? OR path = ? OR path = ?
         )`,
        [normProject, normTarget, normTarget, normTarget, strippedTarget]
    );

    // AC-ARCH-02-04: Isolated symbol with 0 matches yields readSet: []
    if (startNodes.length === 0) {
        return {
            status: isUnknown ? 'unknown' : 'ready',
            project: normProject,
            symbolOrFile: normTarget,
            buildId: buildId || null,
            readSet: [],
            totalFound: 0,
            capped: false,
            depth: 0,
            coverage: compVal,
            completeness: completenessObj,
        };
    }

    const startNodeIds = new Set();
    const originPaths = new Set();

    for (const node of startNodes) {
        startNodeIds.add(node.id);
        if (node.path) originPaths.add(node.path.replace(/\\/g, '/'));

        // If start node is a file, also include symbols declared by this file in the initial set
        if (node.kind === 'file') {
            try {
                const declaredEdges = db.all(
                    `SELECT target_id FROM graph_edge
                     WHERE project = ? AND source_id = ? AND relation = 'declares'`,
                    [normProject, node.id]
                );
                for (const edge of declaredEdges) {
                    startNodeIds.add(edge.target_id);
                }
            } catch {}
        }
    }

    // 2. BFS traversal depth <= 2 (AC-ARCH-02-01, INV-GR-01)
    const visitedNodeIds = new Set(startNodeIds);
    const foundFiles = new Set();
    let currentLevelIds = Array.from(startNodeIds);
    let maxDepthReached = 0;

    for (let depth = 1; depth <= 2; depth++) {
        if (currentLevelIds.length === 0) break;

        const placeholders = currentLevelIds.map(() => '?').join(',');
        const queryParams = [normProject, ...currentLevelIds, ...currentLevelIds];

        // INV-GR-01: Chỉ duyệt theo quan hệ thật trong graph_edge (references, maps_to, declares)
        const edges = db.all(
            `SELECT source_id, target_id, relation
             FROM graph_edge
             WHERE project = ?
               AND relation IN ('references', 'maps_to', 'declares')
               AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`,
            queryParams
        );

        if (edges.length === 0) break;

        const nextLevelIds = [];
        const currentSet = new Set(currentLevelIds);

        for (const edge of edges) {
            const neighborId = currentSet.has(edge.source_id) ? edge.target_id : edge.source_id;
            if (!visitedNodeIds.has(neighborId)) {
                visitedNodeIds.add(neighborId);
                nextLevelIds.push(neighborId);
            }
        }

        if (nextLevelIds.length === 0) break;
        maxDepthReached = depth;

        // Fetch neighbor node details to extract files
        const neighborPlaceholders = nextLevelIds.map(() => '?').join(',');
        const neighborNodes = db.all(
            `SELECT id, kind, name, path
             FROM graph_node
             WHERE project = ? AND id IN (${neighborPlaceholders})`,
            [normProject, ...nextLevelIds]
        );

        for (const node of neighborNodes) {
            const filePath = (node.path || (node.kind === 'file' ? node.name : ''))
                .replace(/\\/g, '/')
                .trim();
            if (filePath && !originPaths.has(filePath)) {
                foundFiles.add(filePath);
            }
        }

        currentLevelIds = nextLevelIds;
    }

    // 3. Fanout cap enforcement (AC-ARCH-02-05)
    const allFiles = Array.from(foundFiles);
    const totalFound = allFiles.length;
    const capped = totalFound > effMaxFanout;
    const readSet = capped ? allFiles.slice(0, effMaxFanout) : allFiles;

    return {
        status: isUnknown ? 'unknown' : 'ready',
        project: normProject,
        symbolOrFile: normTarget,
        buildId: buildId || null,
        readSet,
        totalFound,
        capped,
        depth: maxDepthReached,
        coverage: compVal,
        completeness: completenessObj,
    };
}
