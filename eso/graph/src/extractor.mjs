/**
 * eso/graph extractor — Off-path AST project graph extraction (ESO-45 / Slice S1).
 *
 * Invariants:
 * - INV-GR-01: Extractor does not run on the turn path (runs off-path).
 * - INV-GR-02: AST model is the single source of truth for static relationships.
 * - INV-GR-03: All nodes/edges tagged with project; project isolation.
 * - BR-05: unknown != absent: parse error reduces coverage, never treated as absent.
 */

import crypto from 'node:crypto';
import { calculateCompleteness } from './completeness.mjs';

/**
 * Generate a deterministic node identifier (AC-ARCH-01-04, INV-GR-03).
 *
 * @param {string} project - Project identifier
 * @param {string} kind - Node kind ('file', 'class', 'method', 'module', etc.)
 * @param {string} [logicalPath=''] - Logical file path
 * @param {string} [symbol=''] - Symbol identifier or declaration name
 * @returns {string} Deterministic node ID
 */
export function generateNodeId(project, kind, logicalPath = '', symbol = '') {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('project is required (INV-GR-03)');
    }
    if (!kind || typeof kind !== 'string' || !kind.trim()) {
        throw new Error('kind is required');
    }

    const normProject = project.trim();
    const normKind = kind.trim();
    const normPath = (logicalPath == null ? '' : String(logicalPath)).replace(/\\/g, '/').trim();
    const normSymbol = (symbol == null ? '' : String(symbol)).trim();

    const rawKey = `${normProject}:${normKind}:${normPath}:${normSymbol}`;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
    return `node_${hash}`;
}

/**
 * Extract project graph from manifest entries off-path (INV-GR-01).
 *
 * @param {string} project - Target project ID
 * @param {string|null} [buildId=null] - Build or commit identifier
 * @param {Array<string|{ path: string, name?: string, symbols?: Array<string|{ name: string, kind?: string, metadata?: object }>, metadata?: object, error?: any, parseError?: boolean, parse?: Function }>} manifestEntries
 * @param {object} [options={}]
 * @param {boolean} [options.onTurnPath=false] - Guard against running on turn-path (INV-GR-01)
 * @param {Function} [options.parser=null] - Custom parser function (entry) => ({ symbols: [...] })
 * @param {Function} [options.parseFile=null] - File parser function
 * @param {object} [options.db=null] - Database instance to persist nodes/edges
 * @returns {{
 *   project: string,
 *   buildId: string|null,
 *   status: 'ready' | 'unknown',
 *   coverage: number,
 *   scannedNodesCount: number,
 *   node_count: number,
 *   nodes: Array<object>,
 *   edges: Array<object>,
 *   failedFiles: string[],
 *   errors: Array<{ path: string, error: string }>,
 *   completeness: object
 * }}
 */
export function extractProjectGraph(project, buildId = null, manifestEntries = [], options = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('project is required (INV-GR-03)');
    }

    // Guard INV-GR-01: Extractor must not run on turn path
    if (options?.onTurnPath) {
        throw new Error('INV-GR-01: Extractor cannot run on turn path');
    }

    const entries = Array.isArray(manifestEntries) ? manifestEntries : [];

    // AC-ARCH-01-05: 0 manifest or unextracted -> coverage = 0, status = 'unknown', nodes = [], scannedNodesCount = 0
    if (entries.length === 0) {
        return {
            project: project.trim(),
            buildId: buildId || null,
            status: 'unknown',
            coverage: 0,
            scannedNodesCount: 0,
            node_count: 0,
            nodes: [],
            edges: [],
            failedFiles: [],
            errors: [],
            completeness: {
                question: 'Q1',
                kinds: ['file'],
                value: 0,
                status: 'unknown',
                coverage: 0,
            },
        };
    }

    const nodes = [];
    const edges = [];
    const failedFiles = [];
    const errors = [];
    const now = new Date().toISOString();

    for (const entry of entries) {
        const rawPath = typeof entry === 'string' ? entry : (entry?.path || entry?.name || '');
        const logicalPath = rawPath.replace(/\\/g, '/').trim();

        // Check if entry already marked with error
        if (typeof entry === 'object' && entry !== null) {
            if (entry.error || entry.parseError || entry.failed) {
                failedFiles.push(logicalPath);
                errors.push({
                    path: logicalPath,
                    error: entry.error ? (entry.error.message || String(entry.error)) : 'Parse error',
                });
                continue;
            }
        }

        try {
            let extractedData = null;
            if (typeof options?.parser === 'function') {
                extractedData = options.parser(entry);
            } else if (typeof options?.parseFile === 'function') {
                extractedData = options.parseFile(entry);
            } else if (typeof entry?.parse === 'function') {
                extractedData = entry.parse();
            }

            if (extractedData?.error) {
                throw extractedData.error instanceof Error
                    ? extractedData.error
                    : new Error(String(extractedData.error));
            }

            const baseName = logicalPath.split('/').pop() || logicalPath;
            const fileNodeId = generateNodeId(project, 'file', logicalPath, '');
            const fileNode = {
                id: fileNodeId,
                project,
                kind: 'file',
                name: (typeof entry === 'object' && entry?.name) ? entry.name : baseName,
                path: logicalPath,
                metadata_json: JSON.stringify(typeof entry === 'object' && entry?.metadata ? entry.metadata : {}),
                created_at: now,
                updated_at: now,
            };
            nodes.push(fileNode);

            const rawSymbols = extractedData?.symbols || (typeof entry === 'object' ? entry?.symbols : null) || [];
            for (const sym of rawSymbols) {
                const symName = typeof sym === 'string' ? sym : sym?.name;
                const symKind = (typeof sym === 'object' && sym?.kind) ? sym.kind : 'symbol';
                if (!symName) continue;

                const symNodeId = generateNodeId(project, symKind, logicalPath, symName);
                const symNode = {
                    id: symNodeId,
                    project,
                    kind: symKind,
                    name: symName,
                    path: logicalPath,
                    metadata_json: JSON.stringify(typeof sym === 'object' && sym?.metadata ? sym.metadata : {}),
                    created_at: now,
                    updated_at: now,
                };
                nodes.push(symNode);

                const edgeId = `edge_${fileNodeId}_${symNodeId}`;
                edges.push({
                    id: edgeId,
                    project,
                    source_id: fileNodeId,
                    target_id: symNodeId,
                    relation: 'declares',
                    metadata_json: '{}',
                    created_at: now,
                });
            }
        } catch (err) {
            // AC-ARCH-01-06: isolate file error, do not abort extraction of other files
            failedFiles.push(logicalPath);
            errors.push({
                path: logicalPath,
                error: err?.message || String(err),
            });
        }
    }

    const total = entries.length;
    const validCount = total - failedFiles.length;
    const rawCoverage = total > 0 ? validCount / total : 0;
    const coverage = Number(rawCoverage.toFixed(4));

    // BR-05: unknown != absent: status is 'unknown' if coverage < 1.0 or failedFiles exist, never absent
    const status = (coverage >= 1.0 && failedFiles.length === 0) ? 'ready' : 'unknown';

    const completeness = calculateCompleteness('Q1', {
        file: { covered: validCount, total },
    });

    // Optional database persistence
    if (options?.db && typeof options.db.run === 'function') {
        for (const node of nodes)
            options.db.run(
                `INSERT OR REPLACE INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [node.id, node.project, node.kind, node.name, node.path, node.metadata_json, node.created_at, node.updated_at]
            );
        for (const edge of edges)
            options.db.run(
                `INSERT OR REPLACE INTO graph_edge (id, project, source_id, target_id, relation, metadata_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [edge.id, edge.project, edge.source_id, edge.target_id, edge.relation, edge.metadata_json, edge.created_at]
            );
    }

    return {
        project: project.trim(),
        buildId: buildId || null,
        status,
        coverage,
        scannedNodesCount: nodes.length,
        node_count: nodes.length,
        nodes,
        edges,
        failedFiles,
        errors,
        completeness,
    };
}
