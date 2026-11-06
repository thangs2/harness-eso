/**
 * @mu/eso-graph — graph store service (US-GRAPH-03 / BIP 2.7 / ESO-403)
 *
 * Enforces the parts of API-28/29/30 that live below HTTP:
 * - `graph_index_run` is the idempotency ledger: same source hash replays, a different hash conflicts.
 * - rebuild replaces the rows of exactly one `(project, build_id)` inside one transaction.
 * - query answers carry the completeness of THEIR question, and refuse to answer below the floor
 *   (BR-05: unknown is not absent).
 * - every operation is off-path; the caller marks a turn-scoped request, and it is refused before
 *   touching the store.
 *
 * Engine: PostgreSQL only (D-92/D-93). This module contains no SQLite path.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extractRoslynGraph, indexGraphApi28, persistGraphResult } from './roslyn-adapter.mjs';
import { queryReadSet, DEFAULT_THRESHOLD } from './q1-readset.mjs';
import { queryColumnImpact, DEFAULT_THRESHOLD_Q2 } from './q2-impact.mjs';
import { queryCircularDependencies, DEFAULT_THRESHOLD_Q3 } from './q3-cycles.mjs';
import { queryEndpointPermissions } from './q4-permissions.mjs';
import { querySliceTenantBoundary } from './q5-tenant.mjs';

export const GRAPH_QUESTIONS = Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
export const DEFAULT_GRAPH_FLOOR = 0.70;

/** Floor is data (D-11): server config, never a request field. */
export function graphFloor(env = process.env) {
    const raw = Number(env?.ESO_GRAPH_FLOOR);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_GRAPH_FLOOR;
}

const HASH_SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git']);

function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!HASH_SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
            continue;
        }
        if (entry.isFile()) out.push(path.join(dir, entry.name));
    }
    return out;
}

/**
 * Hash the source tree that a build came from, not just the solution file: editing a `.cs`
 * file must make the same `build_id` a conflict, not a replay.
 */
export function hashGraphSource({ kind, solutionPath }) {
    const root = fs.statSync(solutionPath).isDirectory() ? solutionPath : path.dirname(solutionPath);
    const hash = createHash('sha256');
    hash.update(`${kind}\0`);
    for (const file of sourceFiles(root).sort()) {
        hash.update(path.relative(root, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function missing(message) {
    return { status: 400, code: 'MISSING_INPUT', data: { error: 'MISSING_INPUT', message } };
}

function heavyOnTurn() {
    return {
        status: 409,
        code: 'HEAVY_ON_TURN',
        data: { error: 'HEAVY_ON_TURN', message: 'Graph work is off-path and cannot run while a turn is judging' },
    };
}

function toolchainUnavailable(message) {
    return {
        status: 503,
        code: 'TOOLCHAIN_UNAVAILABLE',
        data: { error: 'TOOLCHAIN_UNAVAILABLE', message, status: 'UNKNOWN' },
    };
}

function resolveSourcePath(source, consumerRoot) {
    const root = consumerRoot ? path.resolve(consumerRoot) : null;
    const fullPath = root ? path.resolve(root, source.solution_path) : path.resolve(source.solution_path);
    if (root) {
        const relative = path.relative(root, fullPath);
        const escaped = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        if (escaped) {
            return {
                error: {
                    status: 403,
                    code: 'BLOCKED_SCOPE',
                    data: { error: 'BLOCKED_SCOPE', message: 'solution_path cannot escape consumer root' },
                },
            };
        }
    }
    return { fullPath };
}

export async function readIndexRun(db, { project, buildId, sourceKind = 'roslyn' }) {
    return db.get(
        `SELECT project, build_id, source_kind, source_hash, source_path, status, created_at, completed_at
         FROM graph_index_run
         WHERE project = ? AND build_id = ? AND source_kind = ?`,
        [project, buildId, sourceKind]
    );
}

async function beginIndexRun(db, { project, buildId, sourceKind, sourceHash, sourcePath }) {
    await db.run(
        `INSERT INTO graph_index_run (project, build_id, source_kind, source_hash, source_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', now())
         ON CONFLICT (project, build_id, source_kind) DO NOTHING`,
        [project, buildId, sourceKind, sourceHash, sourcePath]
    );
}

async function finishIndexRun(db, { project, buildId, sourceKind, status }) {
    await db.run(
        `UPDATE graph_index_run
         SET status = ?, completed_at = now()
         WHERE project = ? AND build_id = ? AND source_kind = ?`,
        [status, project, buildId, sourceKind]
    );
}

/**
 * API-28. Returns an envelope `{ status, code, data }`; the HTTP layer maps status → exception.
 */
export async function indexGraph({
    db,
    project,
    buildId,
    source,
    onTurnPath = false,
    consumerRoot = null,
} = {}) {
    if (onTurnPath) return heavyOnTurn();
    if (!project || !buildId || !source) return missing('project, build_id, and source are required');
    if (source.kind !== 'roslyn') {
        return { status: 400, code: 'UNSUPPORTED_SOURCE', data: { error: 'UNSUPPORTED_SOURCE', message: 'source.kind must be roslyn' } };
    }
    if (!source.solution_path) return missing('source.solution_path is required');

    const resolved = resolveSourcePath(source, consumerRoot);
    if (resolved.error) return resolved.error;
    const { fullPath } = resolved;
    if (!fs.existsSync(fullPath)) {
        return toolchainUnavailable(`Solution file not found: ${source.solution_path}`);
    }

    const sourceHash = hashGraphSource({ kind: source.kind, solutionPath: fullPath });
    const existing = await readIndexRun(db, { project, buildId });
    if (existing?.status === 'failed') {
        // A failed run has no usable rows and its keys are immutable by trigger. Delete the
        // failed ledger row; the fresh insert below records the new source hash/path.
        await db.run(
            'DELETE FROM graph_index_run WHERE project = ? AND build_id = ? AND source_kind = ? AND status = ?',
            [project, buildId, source.kind, 'failed']
        );
    }

    if (existing && existing.status !== 'failed') {
        if (existing.source_hash !== sourceHash) {
            return {
                status: 409,
                code: 'CONFLICT',
                data: {
                    error: 'CONFLICT',
                    message: `build_id '${buildId}' already exists with a different source`,
                },
            };
        }
        return {
            status: 202,
            code: 'REPLAYED',
            data: {
                project,
                build_id: buildId,
                status: 'queued',
                replayed: true,
                accepted_at: new Date().toISOString(),
            },
        };
    }

    await beginIndexRun(db, {
        project,
        buildId,
        sourceKind: source.kind,
        sourceHash,
        sourcePath: fullPath,
    });

    let result;
    try {
        result = await indexGraphApi28(
            { project, build_id: buildId, source },
            { db, consumerRoot: consumerRoot || undefined }
        );
    } catch (err) {
        await finishIndexRun(db, { project, buildId, sourceKind: source.kind, status: 'failed' });
        if (err.code === 'TOOLCHAIN_UNAVAILABLE' || err.status === 503) return toolchainUnavailable(err.message);
        if (err.code === 'HEAVY_ON_TURN' || err.status === 409) return heavyOnTurn();
        throw err;
    }

    if (result.status === 202) {
        const status = result.code === 'PARSE_FAILED' ? 'parse_failed' : 'succeeded';
        await finishIndexRun(db, { project, buildId, sourceKind: source.kind, status });
        return result;
    }

    await finishIndexRun(db, { project, buildId, sourceKind: source.kind, status: 'failed' });
    return result;
}

/**
 * API-29. Full replacement of one build: extract first, then swap rows in one transaction.
 */
export async function rebuildGraph({
    db,
    project,
    buildId,
    source = null,
    onTurnPath = false,
    consumerRoot = null,
} = {}) {
    if (onTurnPath) return heavyOnTurn();
    if (!project || !buildId) return missing('project and build_id are required');

    const run = await readIndexRun(db, { project, buildId });
    if (!run) {
        if (!source) return missing(`build_id '${buildId}' has no index run; provide source to build it`);
        return indexGraph({ db, project, buildId, source, onTurnPath, consumerRoot });
    }
    if (!run.source_path || !fs.existsSync(run.source_path)) {
        return toolchainUnavailable(`Indexed source no longer exists for build_id '${buildId}'`);
    }

    let result;
    try {
        result = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: run.source_path,
            onTurnPath: false,
            db: null,
            consumerRoot: consumerRoot || undefined,
        });
    } catch (err) {
        await finishIndexRun(db, { project, buildId, sourceKind: run.source_kind, status: 'failed' });
        if (err.code === 'TOOLCHAIN_UNAVAILABLE' || err.status === 503) return toolchainUnavailable(err.message);
        if (err.code === 'HEAVY_ON_TURN' || err.status === 409) return heavyOnTurn();
        throw err;
    }

    await db.begin(async (tx) => {
        // Replace exactly this build. source_claim is append-only, so claims of removed edges stay
        // as history; queries join the current edge set and never read an orphan as an answer.
        await tx.run('DELETE FROM graph_edge WHERE project = ? AND build_id = ?', [project, buildId]);
        await tx.run('DELETE FROM graph_node WHERE project = ? AND build_id = ?', [project, buildId]);
        await persistGraphResult(tx, result, { project, buildId });
    });

    await finishIndexRun(db, { project, buildId, sourceKind: run.source_kind, status: 'succeeded' });

    return {
        status: 202,
        code: 'ACCEPTED',
        data: {
            project,
            build_id: buildId,
            status: 'queued',
            replayed: false,
            accepted_at: new Date().toISOString(),
        },
    };
}

async function resolveBuildId(db, { project, question }) {
    const row = await db.get(
        `SELECT build_id FROM completeness
         WHERE project = ? AND question = ?
         ORDER BY measured_at DESC LIMIT 1`,
        [project, question]
    );
    return row ? row.build_id : null;
}

function normalizeStatus(value) {
    if (value === 'absent') return 'absent';
    if (value === 'ready' || value === 'answered') return 'ready';
    return 'unknown';
}

async function runQuestion(db, { question, project, buildId, value, input }) {
    switch (question) {
        case 'Q1': {
            const target = input.symbol || input.file;
            if (!target) return { error: missing('symbol or file is required') };
            const result = await queryReadSet(db, {
                project,
                symbolOrFile: target,
                buildId,
                completeness: value,
                threshold: Math.max(DEFAULT_THRESHOLD, value),
            });
            const readSet = (result.readSet || []).map((entry) =>
                typeof entry === 'string' ? { path: entry } : entry
            );
            return {
                status: normalizeStatus(result.status),
                answer: {
                    read_set: readSet,
                    returned: readSet.length,
                    total: result.totalFound ?? readSet.length,
                    capped: Boolean(result.capped),
                },
                unknowns: result.unknowns || (result.status === 'unknown' ? [{ reason: 'INCOMPLETE_COVERAGE' }] : []),
                code: result.status === 'absent' ? undefined : result.error,
            };
        }
        case 'Q2': {
            if (!input.table) return { error: missing('table is required') };
            const result = await queryColumnImpact(db, {
                project,
                table: input.table,
                column: input.column || null,
                buildId,
                completeness: value,
                threshold: Math.max(DEFAULT_THRESHOLD_Q2, value),
            });
            if (result.status === 'REFUSED') return { error: { status: 422, code: result.error || 'NO_COVERAGE', data: result } };
            return {
                status: normalizeStatus(result.status),
                answer: {
                    table: result.table,
                    column: result.column,
                    impact_chain: result.impactChain || [],
                    impacted_files: result.impactedFiles || [],
                },
                unknowns: result.unknowns || [],
                code: result.error,
            };
        }
        case 'Q3': {
            const result = await queryCircularDependencies(db, {
                project,
                buildId,
                completeness: value,
                threshold: Math.max(DEFAULT_THRESHOLD_Q3, value),
            });
            if (result.status === 'REFUSED') return { error: { status: 422, code: result.error || 'NO_COVERAGE', data: result } };
            return {
                status: normalizeStatus(result.status),
                answer: { has_cycles: Boolean(result.hasCycles), cycles: result.cycles || [] },
                unknowns: result.unknowns || [],
                code: result.error,
            };
        }
        case 'Q4': {
            if (!input.endpoint_id) return { error: missing('endpoint_id is required') };
            const result = await queryEndpointPermissions({
                endpointId: input.endpoint_id,
                project,
                db,
                buildId,
                coverage: value,
            });
            return {
                status: normalizeStatus(result.status),
                answer: {
                    endpoint: result.endpoint,
                    permission: result.permission ?? null,
                    grant: result.grant ?? null,
                    granted_at: result.granted_at ?? null,
                    path: result.path || [],
                },
                unknowns: result.unknowns || [],
                code: result.code,
            };
        }
        case 'Q5': {
            if (!input.slice_id) return { error: missing('slice_id is required') };
            const result = await querySliceTenantBoundary({
                sliceId: input.slice_id,
                project,
                db,
                buildId,
                coverage: value,
            });
            return {
                status: normalizeStatus(result.status),
                answer: {
                    slice_id: result.slice_id,
                    touches_tenant: result.touches_tenant ?? null,
                    evidence: result.evidence || [],
                },
                unknowns: result.unknowns || [],
                code: result.code,
            };
        }
        default:
            return { error: { status: 400, code: 'MISSING_INPUT', data: { error: 'MISSING_INPUT', message: `Unknown question '${question}'` } } };
    }
}

/**
 * API-30..34. One question, its own completeness row, floor enforced before any traversal.
 */
export async function answerGraphQuestion({
    db,
    project,
    question,
    buildId = null,
    input = {},
    floor = graphFloor(),
    onTurnPath = false,
} = {}) {
    if (onTurnPath) return heavyOnTurn();
    if (!project) return missing('project is required');
    const normalized = String(question || '').toUpperCase();
    if (!GRAPH_QUESTIONS.includes(normalized)) {
        return { status: 400, code: 'MISSING_INPUT', data: { error: 'MISSING_INPUT', message: `question must be one of ${GRAPH_QUESTIONS.join(', ')}` } };
    }

    let effectiveBuildId = buildId || null;
    if (!effectiveBuildId) effectiveBuildId = await resolveBuildId(db, { project, question: normalized });
    if (!effectiveBuildId) {
        return { status: 422, code: 'NO_COVERAGE', data: { error: 'NO_COVERAGE', message: 'No completeness row for this project/question' } };
    }

    const row = await db.get(
        `SELECT per_kind, value FROM completeness
         WHERE project = ? AND build_id = ? AND question = ?`,
        [project, effectiveBuildId, normalized]
    );
    if (!row) {
        return { status: 422, code: 'NO_COVERAGE', data: { error: 'NO_COVERAGE', message: 'No completeness row for this build/question' } };
    }

    const value = Number(row.value);
    const perKind = typeof row.per_kind === 'object' && row.per_kind !== null ? row.per_kind : {};
    const completeness = {
        question: normalized,
        value,
        kinds: perKind,
        floor,
    };
    const base = {
        project,
        question: normalized,
        build_id: effectiveBuildId,
        as_of: new Date().toISOString(),
        completeness,
    };

    // BR-05: below the floor the answer is unknown + what is missing, never an empty "absent".
    if (!Number.isFinite(value) || value < floor) {
        return {
            status: 200,
            code: 'LOW_COVERAGE',
            data: {
                ...base,
                status: 'unknown',
                code: 'LOW_COVERAGE',
                answer: {},
                unknowns: [{ reason: 'LOW_COVERAGE', coverage: Number.isFinite(value) ? value : null, kinds: Object.keys(perKind) }],
            },
        };
    }

    let outcome;
    try {
        outcome = await runQuestion(db, {
            question: normalized,
            project,
            buildId: effectiveBuildId,
            value,
            input,
        });
    } catch (err) {
        return {
            status: 422,
            code: err.code || 'NO_COVERAGE',
            data: { error: err.code || 'NO_COVERAGE', message: err.message },
        };
    }
    if (outcome.error) return outcome.error;

    return {
        status: 200,
        code: outcome.code || 'OK',
        data: {
            ...base,
            status: outcome.status,
            answer: outcome.answer,
            unknowns: outcome.unknowns,
            ...(outcome.code ? { code: outcome.code } : {}),
        },
    };
}

export const DOCS_NODE_KINDS = Object.freeze(['method', 'service', 'route', 'module']);
export const DOC_RELATIONS = Object.freeze(['specifies', 'constrains', 'derived_from']);

async function latestBuildId(db, project) {
    const run = await db.get(
        `SELECT build_id FROM graph_index_run WHERE project = ? ORDER BY created_at DESC LIMIT 1`,
        [project]
    );
    if (run) return run.build_id;
    const node = await db.get(
        `SELECT build_id FROM graph_node WHERE project = ? LIMIT 1`,
        [project]
    );
    return node ? node.build_id : null;
}

/**
 * API-35 — docs graph specific-relative.
 *
 * A doc is only returned when a stored edge anchors it to the target node. When nothing anchors
 * the node the answer is `unknown` + UNLINKED_DOC, never a similarity guess (BR-05).
 * A superseded doc is excluded from `docs` and kept in `superseded` with its supersedes trace.
 */
export async function answerDocsGraph({
    db,
    project,
    buildId = null,
    node = {},
    onTurnPath = false,
} = {}) {
    if (onTurnPath) return heavyOnTurn();
    if (!project) return missing('project is required');
    if (!node || typeof node !== 'object' || !node.kind || !node.id) {
        return missing('node.kind and node.id are required');
    }
    if (!DOCS_NODE_KINDS.includes(node.kind)) {
        return missing(`node.kind must be one of ${DOCS_NODE_KINDS.join(', ')}`);
    }

    const effectiveBuildId = buildId || (await latestBuildId(db, project));
    if (!effectiveBuildId) {
        return {
            status: 200,
            code: 'UNLINKED_DOC',
            data: {
                project,
                build_id: null,
                node: { kind: node.kind, id: node.id },
                status: 'unknown',
                as_of: new Date().toISOString(),
                docs: [],
                superseded: [],
                unknowns: [{ reason: 'UNLINKED_DOC', detail: 'no graph build for project' }],
                code: 'UNLINKED_DOC',
            },
        };
    }

    const target = await db.get(
        `SELECT node_id, node_key, path FROM graph_node
         WHERE project = ? AND build_id = ? AND kind = ? AND (node_id = ? OR node_key = ?)
         LIMIT 1`,
        [project, effectiveBuildId, node.kind, node.id, node.id]
    );

    const linked = target
        ? await db.all(
            `SELECT e.edge_id, e.kind AS relation, d.node_id AS doc_id, d.node_key AS doc_key, d.path AS doc_path
             FROM graph_edge e
             JOIN graph_node d
               ON d.project = e.project AND d.build_id = e.build_id AND d.node_id = e.from_node_id
             WHERE e.project = ? AND e.build_id = ?
               AND d.kind = 'doc'
               AND e.kind IN ('specifies','constrains','derived_from')
               AND e.to_node_id = ?
             UNION ALL
             SELECT e.edge_id, e.kind AS relation, d.node_id AS doc_id, d.node_key AS doc_key, d.path AS doc_path
             FROM graph_edge e
             JOIN graph_node d
               ON d.project = e.project AND d.build_id = e.build_id AND d.node_id = e.to_node_id
             WHERE e.project = ? AND e.build_id = ?
               AND d.kind = 'doc'
               AND e.kind IN ('specifies','constrains','derived_from')
               AND e.from_node_id = ?`,
            [project, effectiveBuildId, target.node_id, project, effectiveBuildId, target.node_id]
        )
        : [];

    const supersedeRows = await db.all(
        `SELECT e.from_node_id AS newer_id, e.to_node_id AS older_id,
                n.node_key AS newer_key, COALESCE(n.path, n.node_key) AS newer_path
         FROM graph_edge e
         JOIN graph_node n
           ON n.project = e.project AND n.build_id = e.build_id AND n.node_id = e.from_node_id
         WHERE e.project = ? AND e.build_id = ? AND e.kind = 'supersedes'`,
        [project, effectiveBuildId]
    );
    const supersededBy = new Map(supersedeRows.map((row) => [row.older_id, row]));

    const docs = [];
    const superseded = [];
    for (const row of linked) {
        const entry = {
            doc_path: row.doc_path || row.doc_key,
            relation: row.relation,
            via: [row.doc_key, target.node_key],
        };
        const newer = supersededBy.get(row.doc_id);
        if (newer) {
            superseded.push({
                doc_path: entry.doc_path,
                relation: 'supersedes',
                superseded_by: newer.newer_path || newer.newer_key,
                via: [row.doc_key, newer.newer_key],
            });
        } else {
            docs.push(entry);
        }
    }

    if (docs.length === 0) {
        const allDocs = await db.all(
            `SELECT node_id, node_key, path FROM graph_node
             WHERE project = ? AND build_id = ? AND kind = 'doc'`,
            [project, effectiveBuildId]
        );
        const linkedIds = new Set(linked.map((row) => row.doc_id));
        const unlinked = allDocs
            .filter((doc) => !linkedIds.has(doc.node_id))
            .map((doc) => doc.path || doc.node_key);
        return {
            status: 200,
            code: 'UNLINKED_DOC',
            data: {
                project,
                build_id: effectiveBuildId,
                node: { kind: node.kind, id: node.id },
                status: 'unknown',
                as_of: new Date().toISOString(),
                docs: [],
                superseded,
                unknowns: [{
                    reason: 'UNLINKED_DOC',
                    ...(unlinked.length ? { docs: unlinked } : { detail: 'no doc anchors this node' }),
                }],
                code: 'UNLINKED_DOC',
            },
        };
    }

    return {
        status: 200,
        code: 'OK',
        data: {
            project,
            build_id: effectiveBuildId,
            node: { kind: node.kind, id: node.id },
            status: 'ready',
            as_of: new Date().toISOString(),
            docs,
            superseded,
            unknowns: [],
        },
    };
}
