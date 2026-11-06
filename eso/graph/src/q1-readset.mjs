/**
 * @mu/eso-graph — Q1 Read-Set Query Implementation (ESO-50 / US-ARCH-02 / Slice S1 / ESO-447)
 *
 * Invariants:
 * - D-92 / D-93 / 26.graph-schema.md: Queries PostgreSQL target schema columns:
 *     graph_node(project, build_id, node_id, kind, node_key, path)
 *     graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 *     completeness(project, build_id, question, per_kind, value, measured_at)
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
 * @returns {Promise<object>}
 */
export async function queryReadSet(db, options = {}) {
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

    // If not provided in options, attempt to read from target completeness table (26.graph-schema.md)
    if (compVal === null && db && typeof db.all === 'function') {
        try {
            const rows = await db.all(
                "SELECT value FROM completeness WHERE project = ?" + (buildId ? " AND build_id = ?" : "") + " AND question = 'Q1' ORDER BY measured_at DESC LIMIT 1",
                buildId ? [normProject, buildId] : [normProject]
            );
            if (rows && rows.length > 0 && typeof rows[0].value === 'number') {
                compVal = Math.max(0, Math.min(1, rows[0].value));
            }
        } catch {
            // DB table might not have records
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

    const isUnknown = compVal < effThreshold;
    const completenessObj = {
        question: 'Q1',
        value: compVal,
        status: isUnknown ? 'unknown' : 'ready',
        coverage: compVal,
    };

    if (!db) {
        throw new Error('Database instance is required for Q1 queryReadSet (no silent empty allowed)');
    }

    if (typeof db.all !== 'function' && typeof db.query === 'function') {
        db = {
            all: (sql, params = []) => db.query(sql).all(...(Array.isArray(params) ? params : [params])),
            get: (sql, params = []) => db.query(sql).get(...(Array.isArray(params) ? params : [params])),
            run: (sql, params = []) => db.query(sql).run(...(Array.isArray(params) ? params : [params])),
            exec: (sql) => db.exec(sql),
        };
    }
    if (typeof db.all !== 'function') {
        throw new Error('Database instance must provide .all() method (use db-adapter)');
    }

    // 1. Find initial nodes matching target symbol or file (target columns: node_id, node_key, path)
    const strippedTarget = normTarget.replace(/^\.\//, '');
    const startNodes = await db.all(
        `SELECT node_id AS id, node_id, project, kind, node_key AS name, node_key, path
         FROM graph_node
         WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + ` AND (
             node_id = ? OR node_key = ? OR path = ? OR path = ?
         )`,
        buildId ? [normProject, buildId, normTarget, normTarget, normTarget, strippedTarget] : [normProject, normTarget, normTarget, normTarget, strippedTarget]
    );

    // AC-ARCH-02-04 & ESO-384: Target symbol/file not found in graph
    if (startNodes.length === 0) {
        const isCoverageFull = compVal >= 1.0;
        const status = isCoverageFull ? 'absent' : 'unknown';
        return {
            status,
            project: normProject,
            symbolOrFile: normTarget,
            buildId: buildId || null,
            readSet: [],
            totalFound: 0,
            capped: false,
            depth: 0,
            coverage: compVal,
            completeness: completenessObj,
            reason: status === 'unknown' ? 'SYMBOL_NOT_FOUND_INCOMPLETE_COVERAGE' : 'SYMBOL_ABSENT',
        };
    }

    const startNodeIds = new Set();
    const originPaths = new Set();

    for (const node of startNodes) {
        startNodeIds.add(node.node_id);
        if (node.path) originPaths.add(node.path.replace(/\\/g, '/'));

        // If start node is module/file, also include symbols declared by it
        if (node.kind === 'module' || node.kind === 'file') {
            try {
                const declaredEdges = await db.all(
                    `SELECT to_node_id AS target_id FROM graph_edge
                     WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + ` AND from_node_id = ? AND kind = 'defines'`,
                    buildId ? [normProject, buildId, node.node_id] : [normProject, node.node_id]
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
        const queryParams = buildId
            ? [normProject, buildId, ...currentLevelIds, ...currentLevelIds]
            : [normProject, ...currentLevelIds, ...currentLevelIds];

        // INV-GR-01: Chỉ duyệt theo quan hệ thật trong graph_edge (references, maps_to, defines)
        const edges = await db.all(
            `SELECT from_node_id AS source_id, to_node_id AS target_id, kind AS relation
             FROM graph_edge
             WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + `
               AND kind IN ('references', 'maps_to', 'defines')
               AND (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders}))`,
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
        const neighborNodes = await db.all(
            `SELECT node_id AS id, kind, node_key AS name, path
             FROM graph_node
             WHERE project = ?` + (buildId ? ' AND build_id = ?' : '') + ` AND node_id IN (${neighborPlaceholders})`,
            buildId ? [normProject, buildId, ...nextLevelIds] : [normProject, ...nextLevelIds]
        );

        for (const node of neighborNodes) {
            const filePath = (node.path || (node.kind === 'module' || node.kind === 'file' ? node.name : ''))
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
