/**
 * eso/graph extractor — Off-path AST project graph extraction (ESO-45 / Slice S1 / ESO-447).
 *
 * Invariants:
 * - INV-GR-01: Extractor does not run on the turn path (runs off-path).
 * - INV-GR-02: AST model is the single source of truth for static relationships.
 * - INV-GR-03: All nodes/edges tagged with project; project isolation.
 * - BR-05: unknown != absent: parse error reduces coverage, never treated as absent.
 * - Single pure async contract: always returns a Promise.
 */

import crypto from 'node:crypto';
import { calculateCompleteness } from './completeness.mjs';

/**
 * Generate a deterministic node identifier (AC-ARCH-01-04, INV-GR-03).
 *
 * @param {string} project - Project identifier
 * @param {string} kind - Node kind
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

const ALLOWED_NODE_KINDS = new Set([
    'module', 'namespace', 'class', 'method', 'entity', 'dto', 'table',
    'endpoint', 'permission', 'app_service', 'service', 'route', 'doc'
]);

function normalizeNodeKind(kind, logicalPath = '') {
    if (kind && ALLOWED_NODE_KINDS.has(kind)) return kind;
    if (kind === 'file') {
        return logicalPath.endsWith('.md') ? 'doc' : 'module';
    }
    if (kind === 'symbol' || kind === 'function') return 'method';
    return 'module';
}

/**
 * Extract project graph from manifest entries off-path (INV-GR-01).
 * Pure async contract (always returns a Promise).
 *
 * @param {string} project - Target project ID
 * @param {string|null} [buildId=null] - Build or commit identifier
 * @param {Array} manifestEntries
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function extractProjectGraph(project, buildId = null, manifestEntries = [], options = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        throw new Error('project is required (INV-GR-03)');
    }

    // Guard INV-GR-01: Extractor must not run on turn path
    if (options?.onTurnPath) {
        throw new Error('INV-GR-01: Extractor cannot run on turn path');
    }

    const normProject = project.trim();
    const normBuildId = buildId || 'default';
    const entries = Array.isArray(manifestEntries) ? manifestEntries : [];

    // AC-ARCH-01-05: 0 manifest or unextracted -> coverage = 0, status = 'unknown', nodes = [], scannedNodesCount = 0
    if (entries.length === 0) {
        return {
            project: normProject,
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
                kinds: ['file', 'class', 'method'],
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

    let classCovered = 0;
    let classTotal = 0;
    let methodCovered = 0;
    let methodTotal = 0;

    for (const entry of entries) {
        const rawPath = typeof entry === 'string' ? entry : (entry?.path || entry?.name || '');
        const logicalPath = rawPath.replace(/\\/g, '/').trim();

        if (typeof entry === 'object' && entry !== null) {
            if (entry.error || entry.parseError || entry.failed) {
                failedFiles.push(logicalPath);
                errors.push({
                    path: logicalPath,
                    error: entry.error ? (entry.error.message || String(entry.error)) : 'Parse error',
                });
                if (Array.isArray(entry.symbols)) {
                    for (const sym of entry.symbols) {
                        const symKind = (typeof sym === 'object' && sym?.kind) ? sym.kind : 'method';
                        if (symKind === 'class') classTotal++;
                        if (symKind === 'method') methodTotal++;
                    }
                }
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
            const fileKind = normalizeNodeKind('file', logicalPath);
            const fileNodeId = generateNodeId(normProject, 'file', logicalPath, '');
            const fileNode = {
                id: fileNodeId,
                node_id: fileNodeId,
                project: normProject,
                build_id: normBuildId,
                kind: fileKind,
                name: (typeof entry === 'object' && entry?.name) ? entry.name : baseName,
                node_key: (typeof entry === 'object' && entry?.name) ? entry.name : baseName,
                path: logicalPath,
            };
            nodes.push(fileNode);

            const rawSymbols = extractedData?.symbols || (typeof entry === 'object' ? entry?.symbols : null) || [];
            for (const sym of rawSymbols) {
                const symName = typeof sym === 'string' ? sym : sym?.name;
                const rawKind = (typeof sym === 'object' && sym?.kind) ? sym.kind : 'method';
                const symKind = normalizeNodeKind(rawKind, logicalPath);
                if (!symName) continue;

                if (symKind === 'class') {
                    classCovered++;
                    classTotal++;
                } else if (symKind === 'method') {
                    methodCovered++;
                    methodTotal++;
                }

                const symNodeId = generateNodeId(normProject, symKind, logicalPath, symName);
                const symNode = {
                    id: symNodeId,
                    node_id: symNodeId,
                    project: normProject,
                    build_id: normBuildId,
                    kind: symKind,
                    name: symName,
                    node_key: symName,
                    path: logicalPath,
                };
                nodes.push(symNode);

                const edgeId = `edge_${fileNodeId}_${symNodeId}`;
                edges.push({
                    id: edgeId,
                    edge_id: edgeId,
                    project: normProject,
                    build_id: normBuildId,
                    source_id: fileNodeId,
                    from_node_id: fileNodeId,
                    target_id: symNodeId,
                    to_node_id: symNodeId,
                    relation: 'defines',
                    kind: 'defines',
                    conflict: false,
                });
            }
        } catch (err) {
            // AC-ARCH-01-06: isolate file error
            failedFiles.push(logicalPath);
            errors.push({
                path: logicalPath,
                error: err?.message || String(err),
            });
            if (typeof entry === 'object' && Array.isArray(entry?.symbols)) {
                for (const sym of entry.symbols) {
                    const symKind = (typeof sym === 'object' && sym?.kind) ? sym.kind : 'method';
                    if (symKind === 'class') classTotal++;
                    if (symKind === 'method') methodTotal++;
                }
            }
        }
    }

    const total = entries.length;
    const validCount = total - failedFiles.length;
    const rawCoverage = total > 0 ? validCount / total : 0;
    const fileCoverage = Number(rawCoverage.toFixed(4));

    const completeness = calculateCompleteness('Q1', {
        file: { covered: validCount, total },
        class: { covered: classCovered, total: classTotal },
        method: { covered: methodCovered, total: methodTotal },
    });

    const isReady = fileCoverage >= 1.0 && failedFiles.length === 0 && completeness.status === 'ready';
    const status = isReady ? 'ready' : 'unknown';

    let coverage = null;
    if (isReady) {
        coverage = fileCoverage;
    } else if (completeness.coverage !== null) {
        coverage = Number(completeness.coverage.toFixed(4));
    } else if (fileCoverage < 1.0) {
        coverage = fileCoverage;
    }

    const result = {
        project: normProject,
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

    // Database persistence using target columns (26.graph-schema.md)
    if (options?.db && typeof options.db.run === 'function') {
        for (const node of nodes) {
            await options.db.run(
                `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (project, build_id, node_id) DO UPDATE
                 SET kind = EXCLUDED.kind,
                     node_key = EXCLUDED.node_key,
                     path = EXCLUDED.path`,
                [node.project, node.build_id, node.node_id, node.kind, node.node_key, node.path]
            );
        }
        for (const edge of edges) {
            await options.db.run(
                `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (project, build_id, edge_id) DO UPDATE
                 SET from_node_id = EXCLUDED.from_node_id,
                     to_node_id = EXCLUDED.to_node_id,
                     kind = EXCLUDED.kind,
                     conflict = EXCLUDED.conflict`,
                [edge.project, edge.build_id, edge.edge_id, edge.from_node_id, edge.to_node_id, edge.kind, edge.conflict]
            );
        }
    }

    return result;
}
