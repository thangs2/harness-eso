/**
 * Roslyn C# Extractor Adapter & API-28 Implementation (ESO-401 / BIP 2.9 / D-91 / D-92 / D-93).
 *
 * Invariants:
 * - INV-GR-01: Extractor must never run on turn path (rejected with HEAVY_ON_TURN).
 * - D-91: Roslyn sidecar for C#; toolchain missing/build fail => TOOLCHAIN_UNAVAILABLE (never coverage=0).
 * - D-92/D-93: Graph persistence on PostgreSQL only. SQLite strictly prohibited.
 * - BR-05: Unknown != absent: file parse errors recorded in failed_files, coverage reduced, status unknown.
 * - BR-06: source_claim is append-only, edges carry provenance.
 * - Idempotency: Repeated execution with same build_id updates without duplicating rows.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUESTION_KIND_MAP } from './completeness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const PUBLISHED_DLL = path.resolve(REPO_ROOT, 'eso/extractors/roslyn/bin/Release/publish/RoslynExtractor.dll');
const PROJECT_CSPROJ = path.resolve(REPO_ROOT, 'eso/extractors/roslyn/RoslynExtractor.csproj');

/**
 * Execute Roslyn sidecar asynchronously.
 *
 * @param {object} args
 * @returns {Promise<object>}
 */
async function runRoslynSidecar({ project, buildId, solutionPath, consumerRoot }) {
    return new Promise((resolve, reject) => {
        const useDll = fs.existsSync(PUBLISHED_DLL);
        const cmd = 'dotnet';
        const cmdArgs = useDll
            ? [PUBLISHED_DLL, '--project', project, '--build-id', buildId, '--solution', solutionPath]
            : ['run', '--project', PROJECT_CSPROJ, '--', '--project', project, '--build-id', buildId, '--solution', solutionPath];

        if (consumerRoot) {
            cmdArgs.push('--consumer-root', consumerRoot);
        }

        const child = spawn(cmd, cmdArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (err) => {
            const error = new Error(`TOOLCHAIN_UNAVAILABLE: failed to launch dotnet sidecar: ${err.message}`);
            error.code = 'TOOLCHAIN_UNAVAILABLE';
            error.status = 503;
            reject(error);
        });

        child.on('close', (code) => {
            if (code !== 0 && !stdout.trim()) {
                const error = new Error(`TOOLCHAIN_UNAVAILABLE: Roslyn sidecar exited with code ${code}: ${stderr}`);
                error.code = 'TOOLCHAIN_UNAVAILABLE';
                error.status = 503;
                return reject(error);
            }

            try {
                const data = JSON.parse(stdout);
                if (data.error === 'TOOLCHAIN_UNAVAILABLE') {
                    const error = new Error(`TOOLCHAIN_UNAVAILABLE: ${data.message || 'Toolchain unavailable'}`);
                    error.code = 'TOOLCHAIN_UNAVAILABLE';
                    error.status = 503;
                    return reject(error);
                }
                resolve(data);
            } catch (parseErr) {
                const error = new Error(`TOOLCHAIN_UNAVAILABLE: failed to parse sidecar output: ${parseErr.message}\nOutput: ${stdout}`);
                error.code = 'TOOLCHAIN_UNAVAILABLE';
                error.status = 503;
                reject(error);
            }
        });
    });
}

/**
 * Extract C# project graph using Roslyn sidecar off-path.
 *
 * @param {object} options
 * @param {string} options.project - Project identifier
 * @param {string} options.build_id - Build identifier
 * @param {string} options.solution_path - Path to .sln or .csproj
 * @param {boolean} [options.onTurnPath=false] - Whether invoked on turn path
 * @param {object} [options.db=null] - PostgreSQL db adapter
 * @param {string} [options.consumerRoot=null]
 * @returns {Promise<object>}
 */
export async function extractRoslynGraph({
    project,
    build_id,
    solution_path,
    onTurnPath = false,
    db = null,
    consumerRoot = null,
} = {}) {
    if (!project || typeof project !== 'string' || !project.trim()) {
        const err = new Error('MISSING_INPUT: project is required (INV-GR-03)');
        err.code = 'MISSING_INPUT';
        err.status = 400;
        throw err;
    }

    const normProject = project.trim();
    const normBuildId = (build_id || 'default').trim();

    // Guard INV-GR-01: Extractor must never run on turn path
    if (onTurnPath) {
        const err = new Error('HEAVY_ON_TURN: C# Roslyn extraction cannot run on turn path (INV-GR-01)');
        err.code = 'HEAVY_ON_TURN';
        err.status = 409;
        throw err;
    }

    if (!solution_path) {
        const err = new Error('TOOLCHAIN_UNAVAILABLE: solution_path is required');
        err.code = 'TOOLCHAIN_UNAVAILABLE';
        err.status = 503;
        throw err;
    }

    const fullSolutionPath = path.resolve(solution_path);
    if (!fs.existsSync(fullSolutionPath)) {
        const err = new Error(`TOOLCHAIN_UNAVAILABLE: solution path not found: ${solution_path}`);
        err.code = 'TOOLCHAIN_UNAVAILABLE';
        err.status = 503;
        throw err;
    }

    // Run Roslyn sidecar
    const result = await runRoslynSidecar({
        project: normProject,
        buildId: normBuildId,
        solutionPath: fullSolutionPath,
        consumerRoot,
    });

    if (db && typeof db.run === 'function') {
        await persistGraphResult(db, result, { project: normProject, buildId: normBuildId });
    }

    return result;
}

/**
 * Persist an extraction result into the graph tables.
 *
 * Kept separate from the extractor so API-29 can snapshot the sidecar output first and then
 * replace a build inside one transaction instead of upserting row-by-row over live data.
 *
 * @param {object} db - adapter with .run()
 * @param {object} result - sidecar result { nodes, edges, source_claims, completeness }
 * @param {{project?: string, buildId?: string}} [scope]
 */

/** Persist one completeness row for every question from manifest vs indexed kinds. */
async function persistQuestionCompleteness(db, { project, buildId, fallback }) {
    const manifest = new Map();
    const indexed = new Map();
    try {
        const rows = await db.all(
            'SELECT kind, count(*)::int AS n FROM manifest_entry WHERE project = ? AND build_id = ? GROUP BY kind',
            [project, buildId]
        );
        for (const row of rows || []) manifest.set(row.kind, Number(row.n) || 0);
        const rows2 = await db.all(
            'SELECT kind, count(*)::int AS n FROM graph_node WHERE project = ? AND build_id = ? GROUP BY kind',
            [project, buildId]
        );
        for (const row of rows2 || []) indexed.set(row.kind, Number(row.n) || 0);
    } catch {
        return;
    }
    for (const [question, kinds] of Object.entries(QUESTION_KIND_MAP)) {
        const perKind = {};
        let unknown = false;
        for (const kind of kinds) {
            const total = manifest.get(kind) || 0;
            const covered = indexed.get(kind) || 0;
            if (total <= 0) { perKind[kind] = null; unknown = true; }
            else perKind[kind] = Math.min(1, covered / total);
        }
        if (question === 'Q1' && fallback?.per_kind && typeof fallback.per_kind === 'object') {
            Object.assign(perKind, fallback.per_kind);
            unknown = Object.values(perKind).some((v) => v === null || v === undefined);
        }
        const ratios = Object.values(perKind).filter((v) => typeof v === 'number');
        const value = unknown || ratios.length !== kinds.length ? 0 : Math.min(...ratios);
        await db.run(
            `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
             VALUES (?, ?, ?, ?, ?, now())
             ON CONFLICT (project, build_id, question) DO UPDATE
             SET per_kind = EXCLUDED.per_kind, value = EXCLUDED.value, measured_at = EXCLUDED.measured_at`,
            [project, buildId, question, perKind, value]
        );
    }
}

export async function persistGraphResult(db, result, scope = {}) {
    const nodes = result.nodes || [];
    const edges = result.edges || [];
    const claims = result.source_claims || [];
    const completeness = result.completeness;
    const fallbackProject = scope.project;
    const fallbackBuildId = scope.buildId;

    for (const node of nodes) {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (project, build_id, node_id) DO UPDATE
             SET kind = EXCLUDED.kind,
                 node_key = EXCLUDED.node_key,
                 path = EXCLUDED.path`,
            [node.project || fallbackProject, node.build_id || fallbackBuildId, node.node_id, node.kind, node.node_key, node.path]
        );
    }

    for (const edge of edges) {
        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (project, build_id, edge_id) DO UPDATE
             SET from_node_id = EXCLUDED.from_node_id,
                 to_node_id = EXCLUDED.to_node_id,
                 kind = EXCLUDED.kind,
                 conflict = EXCLUDED.conflict`,
            [edge.project || fallbackProject, edge.build_id || fallbackBuildId, edge.edge_id, edge.from_node_id, edge.to_node_id, edge.kind, edge.conflict || false]
        );
    }

    for (const claim of claims) {
        await db.run(
            `INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim, at)
             VALUES (?, ?, ?, ?, ?, ?, now())
             ON CONFLICT (project, build_id, edge_id, seq) DO NOTHING`,
            [claim.project || fallbackProject, claim.build_id || fallbackBuildId, claim.edge_id, claim.seq || 1, claim.source_kind || 'roslyn', claim.claim]
        );
    }

    if (completeness) {
        const question = completeness.question || 'Q1';
        const perKind = typeof completeness.per_kind === 'object' ? completeness.per_kind : {};
        const value = completeness.value ?? 0;
        const project = completeness.project || fallbackProject;
        const buildId = completeness.build_id || fallbackBuildId;
        await db.run(
            `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
             VALUES (?, ?, ?, ?, ?, now())
             ON CONFLICT (project, build_id, question) DO UPDATE
             SET per_kind = EXCLUDED.per_kind,
                 value = EXCLUDED.value,
                 measured_at = EXCLUDED.measured_at`,
            [project, buildId, question, perKind, value]
        );
    }

    await persistQuestionCompleteness(db, {
        project: fallbackProject,
        buildId: fallbackBuildId,
        fallback: completeness,
    });

    return { nodes: nodes.length, edges: edges.length, claims: claims.length };
}

/**
 * Handle API-28 contract: POST /v1/graph:index
 *
 * @param {object} payload - Request payload
 * @param {string} payload.project
 * @param {string} payload.build_id
 * @param {object} payload.source - { kind: "roslyn", solution_path: "..." }
 * @param {object} [options={}]
 * @returns {Promise<object>} Response envelope { status, code, data }
 */
export async function indexGraphApi28(payload, options = {}) {
    const { project, build_id, source } = payload || {};

    if (!project || !build_id || !source) {
        return {
            status: 400,
            code: 'MISSING_INPUT',
            data: { error: 'MISSING_INPUT', message: 'project, build_id, and source are required' },
        };
    }

    if (source.kind !== 'roslyn') {
        return {
            status: 400,
            code: 'UNSUPPORTED_SOURCE',
            data: { error: 'UNSUPPORTED_SOURCE', message: 'source.kind must be roslyn' },
        };
    }

    if (!source.solution_path) {
        return {
            status: 400,
            code: 'MISSING_INPUT',
            data: { error: 'MISSING_INPUT', message: 'source.solution_path is required' },
        };
    }

    // Scope check: relative path escaping consumer root
    if (options.consumerRoot) {
        const resolvedPath = path.resolve(options.consumerRoot, source.solution_path);
        const resolvedRoot = path.resolve(options.consumerRoot);
        const relative = path.relative(resolvedRoot, resolvedPath);
        const escaped = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        if (escaped) {
            return {
                status: 403,
                code: 'BLOCKED_SCOPE',
                data: { error: 'BLOCKED_SCOPE', message: 'solution_path cannot escape consumer root' },
            };
        }
    }

    // Turn path check (INV-GR-01 / 409 HEAVY_ON_TURN)
    if (options.onTurnPath) {
        return {
            status: 409,
            code: 'HEAVY_ON_TURN',
            data: { error: 'HEAVY_ON_TURN', message: 'Cannot execute heavy graph index on turn path' },
        };
    }

    // Check solution path existence
    const fullSolutionPath = path.resolve(options.consumerRoot || process.cwd(), source.solution_path);
    if (!fs.existsSync(fullSolutionPath)) {
        return {
            status: 503,
            code: 'TOOLCHAIN_UNAVAILABLE',
            data: {
                error: 'TOOLCHAIN_UNAVAILABLE',
                message: `Solution file not found: ${source.solution_path}`,
                status: 'OUT',
            },
        };
    }

    try {
        const result = await extractRoslynGraph({
            project,
            build_id,
            solution_path: fullSolutionPath,
            onTurnPath: false,
            db: options.db,
            consumerRoot: options.consumerRoot,
        });

        const acceptedAt = new Date().toISOString();

        if (result.failed_files && result.failed_files.length > 0) {
            return {
                status: 202,
                code: 'PARSE_FAILED',
                data: {
                    project,
                    build_id,
                    status: 'unknown',
                    coverage: result.coverage,
                    failed_files: result.failed_files,
                    replayed: false,
                    accepted_at: acceptedAt,
                },
            };
        }

        return {
            status: 202,
            code: 'ACCEPTED',
            data: {
                project,
                build_id,
                status: 'queued',
                replayed: false,
                accepted_at: acceptedAt,
            },
        };
    } catch (err) {
        if (err.code === 'TOOLCHAIN_UNAVAILABLE' || err.status === 503) {
            return {
                status: 503,
                code: 'TOOLCHAIN_UNAVAILABLE',
                data: {
                    error: 'TOOLCHAIN_UNAVAILABLE',
                    message: err.message,
                    status: 'UNKNOWN',
                },
            };
        }
        if (err.code === 'HEAVY_ON_TURN' || err.status === 409) {
            return {
                status: 409,
                code: 'HEAVY_ON_TURN',
                data: { error: 'HEAVY_ON_TURN', message: err.message },
            };
        }
        throw err;
    }
}
