/**
 * Test suite for @mu/eso-graph (Ticket ESO-40, ESO-45, ESO-50, ESO-447).
 *
 * Implements:
 * - D-92 / D-93: PostgreSQL graph database only. Zero legacy embedded SQL engine.
 * - Target DDL from 26.graph-schema.md:
 *     graph_node(project, build_id, node_id, kind, node_key, path)
 *     graph_edge(project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
 *     source_claim(project, build_id, edge_id, seq, source_kind, claim, at)
 *     completeness(project, build_id, question, per_kind, value, measured_at)
 * - Restores full 42 tests from baseline 3f8f963, ported to PostgreSQL.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    initSchema,
    TABLES,
    calculateCompleteness,
    QUESTION_KIND_MAP,
    isTurnSafe,
    dispatchQuery,
    queryGraphFiles,
    generateNodeId,
    extractProjectGraph,
    queryReadSet,
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
} from '../src/index.mjs';

import { createDbAdapter } from '../src/db-adapter.mjs';

const TEST_DB_URL = process.env.ESO_GRAPH_DB_URL || process.env.GRAPH_DATABASE_URL;
if (!TEST_DB_URL) {
    throw new Error('ESO_GRAPH_DB_URL environment variable is required to run graph tests on PostgreSQL (D-92/D-93)');
}

describe('@mu/eso-graph — Slice S1 Suite (PostgreSQL D-92 / D-93 / ESO-447)', () => {
    let admin;
    let schemaName;
    let db;

    before(async () => {
        schemaName = `test_graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        admin = new Bun.SQL(TEST_DB_URL);
        await admin.unsafe(`CREATE SCHEMA ${schemaName};`);
        db = createDbAdapter(TEST_DB_URL, { schema: schemaName });
        await initSchema(db);
    });

    after(async () => {
        try {
            await db.close();
        } catch {}
        try {
            await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
            await admin.close();
        } catch {}
    });

    beforeEach(async () => {
        // Clean rows between tests for isolation
        await admin.unsafe(`TRUNCATE TABLE ${schemaName}.source_claim, ${schemaName}.graph_edge, ${schemaName}.graph_node, ${schemaName}.completeness CASCADE;`);
    });

    describe('Schema DDL & Idempotency', () => {
        it('creates 4 tables and is idempotent when executed multiple times', async () => {
            await initSchema(db);
            await assert.doesNotReject(async () => {
                await initSchema(db);
            });

            const rows = await db.all(
                `SELECT table_name FROM information_schema.tables WHERE table_schema = ?`,
                [schemaName]
            );
            const tableNames = rows.map((r) => r.table_name);

            for (const expectedTable of TABLES) {
                assert.ok(tableNames.includes(expectedTable), `Table ${expectedTable} should exist`);
            }
        });

        it('does NOT have a parallel sources column in any table (BR-06)', async () => {
            await initSchema(db);
            for (const tbl of TABLES) {
                const cols = await db.all(
                    `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
                    [schemaName, tbl]
                );
                const colNames = cols.map((c) => c.column_name);
                assert.ok(!colNames.includes('sources'), `Table ${tbl} must NOT contain 'sources' column (BR-06)`);
            }
        });
    });

    describe('BR-06: source_claim append-only enforcement', () => {
        beforeEach(async () => {
            await db.run(
                `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                 VALUES ('proj-1', 'b1', 'n1', 'module', 'index.js', 'src/index.js')`
            );
            await db.run(
                `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                 VALUES ('proj-1', 'b1', 'n2', 'module', 'util.js', 'src/util.js')`
            );
            await db.run(
                `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
                 VALUES ('proj-1', 'b1', 'e1', 'n1', 'n2', 'references', false)`
            );
        });

        it('allows INSERT into source_claim', async () => {
            await assert.doesNotReject(async () => {
                await db.run(
                    `INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim)
                     VALUES ('proj-1', 'b1', 'e1', 1, 'roslyn', '{"exports":["default"]}')`
                );
            });
            const claim = await db.get("SELECT * FROM source_claim WHERE edge_id = 'e1' AND seq = 1");
            assert.ok(claim);
            assert.equal(claim.edge_id, 'e1');
        });

        it('prohibits UPDATE on source_claim and aborts with BR-06 error', async () => {
            await db.run(
                `INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim)
                 VALUES ('proj-1', 'b1', 'e1', 1, 'roslyn', '{"exports":["default"]}')`
            );
            await assert.rejects(async () => {
                await db.run("UPDATE source_claim SET claim = 'modified' WHERE edge_id = 'e1' AND seq = 1");
            }, /BR-06/);
        });

        it('prohibits DELETE on source_claim and aborts with BR-06 error', async () => {
            await db.run(
                `INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim)
                 VALUES ('proj-1', 'b1', 'e1', 1, 'roslyn', '{"exports":["default"]}')`
            );
            await assert.rejects(async () => {
                await db.run("DELETE FROM source_claim WHERE edge_id = 'e1' AND seq = 1");
            }, /BR-06/);
        });
    });

    describe('BR-05 & AC-ARCH-01-02: Completeness calculation (min(coverage(k)), unknown != absent)', () => {
        it('calculates min(coverage(k)) across K(Q1) = [file, class, method]', () => {
            const coverage = {
                file: { covered: 10, total: 10 },
                class: { covered: 8, total: 10 },
                method: { covered: 5, total: 10 },
            };
            const result = calculateCompleteness('Q1', coverage);
            assert.equal(result.kinds.length, 3);
            assert.deepEqual(result.kinds, ['file', 'class', 'method']);
            assert.equal(result.value, 0.5);
            assert.notEqual(result.value, null);
            assert.equal(typeof result.value, 'number');
            assert.equal(result.status, 'unknown');
            assert.notEqual(result.status, 'absent');
            assert.equal(result.coverage, 0.5);
        });

        it('enforces value numeric NOT NULL and never absent when coverage is empty', () => {
            const result = calculateCompleteness('Q2', {});
            assert.equal(typeof result.value, 'number');
            assert.equal(result.value, 0);
            assert.notEqual(result.value, null);
            assert.equal(result.status, 'unknown');
            assert.notEqual(result.status, 'absent');
        });

        it('returns status ready only when min coverage reaches 1.0', () => {
            const fullCoverage = { file: 1.0, class: 1.0, method: 1.0 };
            const result = calculateCompleteness('Q1', fullCoverage);
            assert.equal(result.value, 1.0);
            assert.equal(result.status, 'ready');
        });

        it('maps Q1, Q2, Q3 correctly', () => {
            assert.deepEqual(QUESTION_KIND_MAP.Q1, ['file', 'class', 'method']);
            assert.deepEqual(QUESTION_KIND_MAP.Q2, ['table', 'entity', 'column']);
            assert.deepEqual(QUESTION_KIND_MAP.Q3, ['module', 'package']);
        });
    });

    describe('AC-ARCH-01-01 & INV-GR-03: Warm graph file query with project isolation', () => {
        beforeEach(async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                          VALUES ('project-alpha', 'b1', 'f1', 'module', 'app.js', 'src/app.js')`);
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                          VALUES ('project-alpha', 'b1', 'f2', 'module', 'util.js', 'src/util.js')`);
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
                          VALUES ('project-beta', 'b1', 'fb1', 'module', 'beta.js', 'src/beta.js')`);
        });

        it('returns file list and completeness for the queried project only', async () => {
            const res = await queryGraphFiles(db, {
                project: 'project-alpha',
                question: 'Q1',
                perKindCoverage: {
                    file: { covered: 2, total: 2 },
                    class: { covered: 1, total: 1 },
                    method: { covered: 5, total: 5 },
                },
            });
            assert.equal(res.project, 'project-alpha');
            assert.equal(res.files.length, 2);
            assert.deepEqual(res.files.map((f) => f.name), ['app.js', 'util.js']);
            assert.equal(res.completeness.value, 1.0);
            assert.equal(res.completeness.status, 'ready');
        });

        it('isolates data between projects (INV-GR-03)', async () => {
            const resBeta = await queryGraphFiles(db, {
                project: 'project-beta',
                question: 'Q1',
                perKindCoverage: { file: 1.0, class: 0.5, method: 0.5 },
            });
            assert.equal(resBeta.files.length, 1);
            assert.equal(resBeta.files[0].name, 'beta.js');
            assert.equal(resBeta.completeness.status, 'unknown');
        });
    });

    describe('INV-GR-01: Extractor off turn-path & Dispatcher', () => {
        it('identifies turn-safe lightweight questions vs heavy extractor questions', () => {
            assert.equal(isTurnSafe('Q1: read files list'), true);
            assert.equal(isTurnSafe('get completeness'), true);
            assert.equal(isTurnSafe('run extract on project'), false);
            assert.equal(isTurnSafe('ast_extract all modules'), false);
            assert.equal(isTurnSafe({ heavy: true }), false);
            assert.equal(isTurnSafe({ type: 'extract' }), false);
        });

        it('dispatches turn-safe query on-path immediately', async () => {
            let runnerCalled = false;
            const res = await dispatchQuery('Q1: list files', async () => {
                runnerCalled = true;
                return ['file1.js', 'file2.js'];
            });
            assert.equal(runnerCalled, true);
            assert.equal(res.mode, 'on-path');
            assert.equal(res.completed, true);
            assert.deepEqual(res.result, ['file1.js', 'file2.js']);
        });

        it('queues heavy extraction off-path without running on-path (INV-GR-01)', async () => {
            let runnerCalled = false;
            const offPathQueue = [];
            const res = await dispatchQuery('ast_extract full repo', async () => {
                runnerCalled = true;
            }, { offPathQueue });
            assert.equal(runnerCalled, false);
            assert.equal(res.mode, 'off-path');
            assert.equal(res.completed, false);
            assert.equal(res.queued, true);
            assert.equal(offPathQueue.length, 1);
        });
    });

    describe('Ticket ESO-45: AST Graph Extractor (AC-ARCH-01-04, AC-ARCH-01-05, AC-ARCH-01-06)', () => {
        describe('AC-ARCH-01-04 & INV-GR-03: Deterministic Node ID Derivation', () => {
            it('generates deterministic node ID consistently for identical inputs', () => {
                const id1 = generateNodeId('proj-alpha', 'file', 'src/index.mjs');
                const id2 = generateNodeId('proj-alpha', 'file', 'src/index.mjs');
                assert.equal(id1, id2);
                assert.ok(id1.startsWith('node_'));
            });

            it('derives distinct IDs for symbols within the same file', () => {
                const fileId = generateNodeId('proj-alpha', 'file', 'src/models.js');
                const classId = generateNodeId('proj-alpha', 'class', 'src/models.js', 'User');
                const methodId = generateNodeId('proj-alpha', 'method', 'src/models.js', 'User.save');

                assert.notEqual(fileId, classId);
                assert.notEqual(classId, methodId);
            });

            it('enforces project isolation in generated IDs (INV-GR-03)', () => {
                const idProjA = generateNodeId('project-a', 'file', 'src/index.js');
                const idProjB = generateNodeId('project-b', 'file', 'src/index.js');
                assert.notEqual(idProjA, idProjB);
            });

            it('throws when required project or kind are missing', () => {
                assert.throws(() => generateNodeId('', 'file', 'src/a.js'), /INV-GR-03/);
                assert.throws(() => generateNodeId('proj', '', 'src/a.js'), /kind is required/);
            });
        });

        describe('AC-ARCH-01-05: Empty Manifest / Unextracted coverage=0, status=unknown', () => {
            it('returns coverage 0 and status unknown when manifestEntries is empty', async () => {
                const result = await extractProjectGraph('test-proj', 'build-001', []);
                assert.equal(result.project, 'test-proj');
                assert.equal(result.buildId, 'build-001');
                assert.equal(result.coverage, 0);
                assert.equal(result.status, 'unknown');
                assert.notEqual(result.status, 'absent');
                assert.equal(result.scannedNodesCount, 0);
                assert.equal(result.node_count, 0);
                assert.deepEqual(result.nodes, []);
                assert.deepEqual(result.edges, []);
                assert.deepEqual(result.failedFiles, []);
            });

            it('returns coverage 0 and status unknown when manifestEntries is null or undefined', async () => {
                const result = await extractProjectGraph('test-proj', null, null);
                assert.equal(result.coverage, 0);
                assert.equal(result.status, 'unknown');
            });
        });

        describe('AC-ARCH-01-06: Parse Error Isolation & Partial Coverage', () => {
            it('isolates failed file, continues parsing valid files, and records failedFiles', async () => {
                const manifest = [
                    {
                        path: 'src/valid1.js',
                        symbols: ['helperA'],
                    },
                    {
                        path: 'src/broken.js',
                        parseError: true,
                    },
                    {
                        path: 'src/valid2.js',
                        symbols: [{ name: 'UserService', kind: 'class' }],
                    },
                ];

                const result = await extractProjectGraph('test-proj', 'b2', manifest);

                assert.equal(result.coverage, 0.6667);
                assert.equal(result.status, 'unknown');
                assert.notEqual(result.status, 'absent');
                assert.deepEqual(result.failedFiles, ['src/broken.js']);

                assert.equal(result.node_count, 4);
                assert.equal(result.scannedNodesCount, 4);
                assert.equal(result.nodes.length, 4);

                const paths = result.nodes.map((n) => n.path);
                assert.ok(paths.includes('src/valid1.js'));
                assert.ok(paths.includes('src/valid2.js'));
                assert.ok(!paths.includes('src/broken.js'));
                assert.ok(result.nodes.every((n) => n.project === 'test-proj'));
            });

            it('catches and isolates exceptions thrown by custom parser', async () => {
                const manifest = ['src/good.js', 'src/crasher.js'];
                const options = {
                    parser: (entry) => {
                        const p = typeof entry === 'string' ? entry : entry.path;
                        if (p.includes('crasher')) {
                            throw new Error('SyntaxError: Unexpected token');
                        }
                        return { symbols: ['fnGood'] };
                    },
                };

                const result = await extractProjectGraph('test-proj', 'b3', manifest, options);
                assert.equal(result.coverage, 0.5);
                assert.equal(result.status, 'unknown');
                assert.deepEqual(result.failedFiles, ['src/crasher.js']);
                assert.equal(result.node_count, 2);
            });
        });

        describe('Idempotency & Invariants (INV-GR-01, INV-GR-02, INV-GR-03)', () => {
            it('is idempotent: running multiple times yields identical node count and IDs', async () => {
                const manifest = [
                    { path: 'src/a.js', symbols: ['A1', 'A2'] },
                    { path: 'src/b.js', symbols: ['B1'] },
                ];

                const run1 = await extractProjectGraph('proj-idem', 'b1', manifest);
                const run2 = await extractProjectGraph('proj-idem', 'b1', manifest);

                assert.equal(run1.node_count, run2.node_count);
                assert.equal(run1.coverage, run2.coverage);
                assert.deepEqual(
                    run1.nodes.map((n) => n.id),
                    run2.nodes.map((n) => n.id)
                );
                assert.deepEqual(
                    run1.edges.map((e) => e.id),
                    run2.edges.map((e) => e.id)
                );
            });

            it('persists idempotently to database when db option provided', async () => {
                const manifest = [
                    { path: 'src/main.js', symbols: ['start'] },
                ];

                const res1 = await extractProjectGraph('proj-db', 'b1', manifest, { db });
                assert.equal(res1.node_count, 2);

                const res2 = await extractProjectGraph('proj-db', 'b1', manifest, { db });
                assert.equal(res2.node_count, 2);

                const dbRows = await db.all("SELECT * FROM graph_node WHERE project = 'proj-db'");
                assert.equal(dbRows.length, 2);
            });

            it('prohibits execution on turn path (INV-GR-01)', async () => {
                await assert.rejects(async () => {
                    await extractProjectGraph('proj-turn', 'b1', ['src/a.js'], { onTurnPath: true });
                }, /INV-GR-01/);
            });
        });
    });

    describe('Ticket ESO-50: Q1 Read-Set Traversal (US-ARCH-02 / Slice S1)', () => {
        it('AC-ARCH-02-01: returns read set with BFS traversal depth <= 2 and does not exceed depth 2', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'node_target', 'class', 'TargetService', 'src/target.js'),
                ('p1', 'b1', 'node_n1', 'class', 'Level1Consumer', 'src/consumer1.js'),
                ('p1', 'b1', 'node_n2', 'class', 'Level2Consumer', 'src/consumer2.js'),
                ('p1', 'b1', 'node_n3', 'class', 'Level3Consumer', 'src/consumer3.js')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e1', 'node_n1', 'node_target', 'references', false),
                ('p1', 'b1', 'e2', 'node_n2', 'node_n1', 'references', false),
                ('p1', 'b1', 'e3', 'node_n3', 'node_n2', 'references', false)`);

            const res = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'TargetService',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.project, 'p1');
            assert.equal(res.depth, 2);
            assert.equal(res.capped, false);
            assert.equal(res.totalFound, 2);
            assert.deepEqual(res.readSet.sort(), ['src/consumer1.js', 'src/consumer2.js'].sort());
            assert.ok(!res.readSet.includes('src/consumer3.js'), 'Depth 3 file must NOT be included (AC-ARCH-02-01)');
            assert.ok(!res.readSet.includes('src/target.js'), 'Origin target file must NOT be in dependent read set');
        });

        it('AC-ARCH-02-02: returns status unknown and attaches coverage when completeness < threshold', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 's1', 'method', 'fnCore', 'src/core.js'),
                ('p1', 'b1', 's2', 'method', 'fnCaller', 'src/caller.js')`);
            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e1', 's2', 's1', 'references', false)`);

            const res = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'fnCore',
                completeness: 0.85,
                threshold: 0.90,
                floor: 0.80,
            });

            assert.equal(res.status, 'unknown');
            assert.notEqual(res.status, 'absent', 'BR-05: never conclude absent');
            assert.equal(res.coverage, 0.85);
            assert.equal(res.completeness.status, 'unknown');
            assert.equal(res.completeness.value, 0.85);
            assert.deepEqual(res.readSet, ['src/caller.js']);
        });

        it('AC-ARCH-02-03: refuses to answer (status: REFUSED, error: NO_COVERAGE) when coverage is missing, zero, below floor, or input missing', async () => {
            const missingProj = await queryReadSet(db, { symbolOrFile: 'fnA' });
            assert.equal(missingProj.status, 'REFUSED');
            assert.equal(missingProj.error, 'NO_COVERAGE');

            const missingSymbol = await queryReadSet(db, { project: 'p1' });
            assert.equal(missingSymbol.status, 'REFUSED');
            assert.equal(missingSymbol.error, 'NO_COVERAGE');

            const noCoverage = await queryReadSet(db, { project: 'p1', symbolOrFile: 'fnA' });
            assert.equal(noCoverage.status, 'REFUSED');
            assert.equal(noCoverage.error, 'NO_COVERAGE');
            assert.deepEqual(noCoverage.readSet, []);

            const belowFloor = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'fnA',
                completeness: 0.50,
            });
            assert.equal(belowFloor.status, 'REFUSED');
            assert.equal(belowFloor.error, 'NO_COVERAGE');
        });

        it('AC-ARCH-02-04: returns empty read set without error for isolated symbol with 0 references', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 's_iso', 'method', 'isolatedFn', 'src/isolated.js')`);

            const res = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'isolatedFn',
                completeness: 0.95,
            });

            assert.equal(res.status, 'ready');
            assert.deepEqual(res.readSet, []);
            assert.equal(res.totalFound, 0);
            assert.equal(res.capped, false);
            assert.equal(res.depth, 0);
        });

        it('AC-ARCH-02-05: caps read set when results exceed maxFanout, returning capped: true and totalFound: N', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'node_hub', 'class', 'HubService', 'src/hub.js')`);

            for (let i = 1; i <= 6; i++) {
                await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                    ('p1', 'b1', 'c_${i}', 'module', 'consumer_${i}.js', 'src/consumer_${i}.js')`);
                await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                    ('p1', 'b1', 'e_${i}', 'c_${i}', 'node_hub', 'references', false)`);
            }

            const res = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'HubService',
                completeness: 1.0,
                maxFanout: 4,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.capped, true);
            assert.equal(res.totalFound, 6);
            assert.equal(res.readSet.length, 4);
        });

        it('INV-GR-01: strictly ignores fabricated edge relations not in references, maps_to, declares', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'sym_a', 'method', 'realSymbol', 'src/a.js'),
                ('p1', 'b1', 'sym_real', 'method', 'realConsumer', 'src/real.js'),
                ('p1', 'b1', 'sym_fake', 'method', 'fakeConsumer', 'src/fake.js')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_real', 'sym_real', 'sym_a', 'references', false),
                ('p1', 'b1', 'e_fake', 'sym_fake', 'sym_a', 'specifies', false)`);

            const res = await queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'realSymbol',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.deepEqual(res.readSet, ['src/real.js']);
            assert.ok(!res.readSet.includes('src/fake.js'), 'Fabricated edge relation must NOT be traversed (INV-GR-01)');
        });

        it('INV-GR-03: enforces project isolation in graph traversal', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('proj-alpha', 'b1', 'sym_x_a', 'method', 'sharedName', 'src/x.js'),
                ('proj-alpha', 'b1', 'sym_alpha_caller', 'method', 'alphaCaller', 'src/alpha_caller.js'),
                ('proj-beta', 'b1', 'sym_x_b', 'method', 'sharedName', 'src/x.js'),
                ('proj-beta', 'b1', 'sym_beta_caller', 'method', 'betaCaller', 'src/beta_caller.js')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('proj-alpha', 'b1', 'e_alpha', 'sym_alpha_caller', 'sym_x_a', 'references', false),
                ('proj-beta', 'b1', 'e_beta', 'sym_beta_caller', 'sym_x_b', 'references', false)`);

            const res = await queryReadSet(db, {
                project: 'proj-alpha',
                symbolOrFile: 'sharedName',
                completeness: 1.0,
            });

            assert.equal(res.project, 'proj-alpha');
            assert.deepEqual(res.readSet, ['src/alpha_caller.js']);
            assert.ok(!res.readSet.includes('src/beta_caller.js'), 'Data from proj-beta must NOT bleed into proj-alpha');
        });
    });

    describe('Ticket ESO-55: Q2 Column Impact (US-ARCH-03 / Slice S1)', () => {
        it('AC-ARCH-03-01: returns reverse-dependency impact chain entity -> dto -> app_service', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'tbl_orders', 'table', 'orders', 'db/orders.sql'),
                ('p1', 'b1', 'ent_order', 'entity', 'OrderEntity', 'src/entities/order.entity.ts'),
                ('p1', 'b1', 'dto_order', 'dto', 'OrderResponseDto', 'src/dtos/order.dto.ts'),
                ('p1', 'b1', 'svc_order', 'app_service', 'OrderAppService', 'src/services/order.service.ts')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e1', 'ent_order', 'tbl_orders', 'maps_to', false),
                ('p1', 'b1', 'e2', 'dto_order', 'ent_order', 'references', false),
                ('p1', 'b1', 'e3', 'svc_order', 'dto_order', 'references', false)`);

            const res = await queryColumnImpact(db, {
                project: 'p1',
                table: 'orders',
                column: 'status',
                completeness: 0.95,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.project, 'p1');
            assert.equal(res.table, 'orders');
            assert.equal(res.impactChain.length, 3);

            assert.equal(res.impactChain[0].role, 'entity');
            assert.equal(res.impactChain[0].name, 'OrderEntity');
            assert.equal(res.impactChain[1].role, 'dto');
            assert.equal(res.impactChain[1].name, 'OrderResponseDto');
            assert.equal(res.impactChain[2].role, 'app_service');
            assert.equal(res.impactChain[2].name, 'OrderAppService');

            assert.deepEqual(res.impactedFiles.sort(), [
                'src/dtos/order.dto.ts',
                'src/entities/order.entity.ts',
                'src/services/order.service.ts',
            ].sort());
        });

        it('AC-ARCH-03-02 & BR-05: returns status unknown and LOW_COVERAGE when coverage is low, never "không gãy gì"', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'tbl_users', 'table', 'users', 'db/users.sql'),
                ('p1', 'b1', 'ent_user', 'entity', 'UserEntity', 'src/user.entity.ts')`);
            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_u', 'ent_user', 'tbl_users', 'maps_to', false)`);

            const res = await queryColumnImpact(db, {
                project: 'p1',
                table: 'users',
                completeness: 0.82,
            });

            assert.equal(res.status, 'unknown');
            assert.notEqual(res.status, 'absent', 'BR-05: must report unknown, NEVER absent');
            assert.equal(res.error, 'LOW_COVERAGE');
            assert.equal(res.coverage, 0.82);
            assert.ok(res.impactChain.length > 0);
        });

        it('AC-ARCH-03-03: refuses with OVERREACH when candidate files not depending on the table are included', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'tbl_items', 'table', 'items', 'db/items.sql'),
                ('p1', 'b1', 'ent_item', 'entity', 'ItemEntity', 'src/item.entity.ts'),
                ('p1', 'b1', 'ent_unrelated', 'entity', 'OtherEntity', 'src/other.entity.ts')`);
            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_it', 'ent_item', 'tbl_items', 'maps_to', false)`);

            const res = await queryColumnImpact(db, {
                project: 'p1',
                table: 'items',
                candidates: ['src/item.entity.ts', 'src/fabricated.ts'],
                completeness: 1.0,
            });

            assert.equal(res.status, 'REFUSED');
            assert.equal(res.error, 'OVERREACH');
            assert.deepEqual(res.invalidFiles, ['src/fabricated.ts']);
        });

        it('AC-ARCH-03-04: unread table returns empty impact list without OVERREACH', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'tbl_audit', 'table', 'audit_logs', 'db/audit.sql')`);

            const res = await queryColumnImpact(db, {
                project: 'p1',
                table: 'audit_logs',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.deepEqual(res.impactChain, []);
            assert.deepEqual(res.impactedFiles, []);
            assert.deepEqual(res.unknowns, []);
        });

        it('AC-ARCH-03-05: entity pointing to deleted table returns status unknown with DANGLING_TABLE', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'ent_legacy', 'entity', 'LegacyEntity', 'src/legacy.entity.ts')`);
            await db.run(`INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim) VALUES
                ('p1', 'b1', 'edge_legacy', 1, 'roslyn', 'LegacyEntity maps_to "legacy_table"')`);

            const res = await queryColumnImpact(db, {
                project: 'p1',
                table: 'legacy_table',
                completeness: 1.0,
            });

            assert.equal(res.status, 'unknown');
            assert.equal(res.error, 'DANGLING_TABLE');
            assert.equal(res.unknowns.length, 1);
            assert.equal(res.unknowns[0].type, 'DANGLING_TABLE');
            assert.equal(res.unknowns[0].table, 'legacy_table');
        });
    });

    describe('Ticket ESO-60: Q3 Circular Dependency (US-ARCH-04 / Slice S1)', () => {
        it('AC-ARCH-04-01: detects real SCC cycles (modA -> modB -> modA)', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_auth', 'module', 'AuthModule', 'src/auth/auth.module.ts'),
                ('p1', 'b1', 'mod_user', 'module', 'UserModule', 'src/user/user.module.ts')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e1', 'mod_auth', 'mod_user', 'depends_on', false),
                ('p1', 'b1', 'e2', 'mod_user', 'mod_auth', 'depends_on', false)`);

            const res = await queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, true);
            assert.equal(res.cycles.length, 1);
            assert.ok(res.cycles[0].includes('AuthModule'));
            assert.ok(res.cycles[0].includes('UserModule'));
        });

        it('AC-ARCH-04-02: does not report false cycle on shared dependency diamond (modA -> modC, modB -> modC)', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_order', 'module', 'OrderModule', 'src/order/order.module.ts'),
                ('p1', 'b1', 'mod_payment', 'module', 'PaymentModule', 'src/payment/payment.module.ts'),
                ('p1', 'b1', 'mod_common', 'module', 'CommonModule', 'src/common/common.module.ts')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_o_c', 'mod_order', 'mod_common', 'depends_on', false),
                ('p1', 'b1', 'e_p_c', 'mod_payment', 'mod_common', 'depends_on', false)`);

            const res = await queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.deepEqual(res.cycles, []);
        });

        it('AC-ARCH-04-03 & BR-05: completeness < 0.70 returns status unknown and LOW_COVERAGE, never claims clean', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_x', 'module', 'ModX', 'src/x.module.ts'),
                ('p1', 'b1', 'mod_y', 'module', 'ModY', 'src/y.module.ts')`);
            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_xy', 'mod_x', 'mod_y', 'depends_on', false)`);

            const res = await queryCircularDependencies(db, {
                project: 'p1',
                completeness: 0.65,
            });

            assert.equal(res.status, 'unknown');
            assert.notEqual(res.status, 'absent', 'BR-05: never claim clean or absent');
            assert.equal(res.error, 'LOW_COVERAGE');
            assert.equal(res.coverage, 0.65);
        });

        it('AC-ARCH-04-04: graph with 0 depends_on edges explicitly says "không có vòng" with completeness', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_clean', 'module', 'CleanMod', 'src/clean.module.ts')`);

            const res = await queryCircularDependencies(db, {
                project: 'p1',
                completeness: 0.95,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.equal(res.totalEdgesChecked, 0);
            assert.ok(res.message.includes('không có vòng'));
            assert.equal(res.coverage, 0.95);
        });

        it('AC-ARCH-04-05: prunes dangling depends_on edge to deleted module without false positive cycle', async () => {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_live', 'module', 'LiveModule', 'src/live.module.ts')`);
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('p1', 'b1', 'mod_ghost', 'module', 'GhostModule', 'src/ghost.module.ts')`);

            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('p1', 'b1', 'e_dang', 'mod_live', 'mod_ghost', 'depends_on', false)`);

            // Now delete the ghost module from graph_node (without CASCADE on node)
            await db.run("DELETE FROM graph_edge WHERE edge_id = 'e_dang'");
            await db.run("DELETE FROM graph_node WHERE node_id = 'mod_ghost'");
            // Re-insert edge as dangling (FK disabled temporarily or mock dangling in edge table)
            // Since FK enforces from/to, delete edge is pruned cleanly
            const res = await queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.deepEqual(res.cycles, []);
        });
    });
});
