/**
 * Test suite for @mu/eso-graph (Ticket ESO-40, ESO-45 & ESO-50 / Slice S1).
 */

import { describe, it, beforeEach } from 'node:test';
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

async function createTestDb() {
    if (typeof Bun !== 'undefined') {
        const { Database } = await import('bun:sqlite');
        const db = new Database(':memory:');
        return {
            exec: (sql) => db.exec(sql),
            all: (sql, params = []) => db.query(sql).all(...params),
            run: (sql, params = []) => db.query(sql).run(...params),
            get: (sql, params = []) => db.query(sql).get(...params),
        };
    } else {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        return {
            exec: (sql) => db.exec(sql),
            all: (sql, params = []) => db.prepare(sql).all(...params),
            run: (sql, params = []) => db.prepare(sql).run(...params),
            get: (sql, params = []) => db.prepare(sql).get(...params),
        };
    }
}

describe('@mu/eso-graph — Slice S1 Suite', () => {
    let db;

    beforeEach(async () => {
        db = await createTestDb();
    });

    describe('Schema DDL & Idempotency', () => {
        it('creates 4 tables and is idempotent when executed multiple times', () => {
            initSchema(db);
            assert.doesNotThrow(() => initSchema(db));

            const rows = db.all("SELECT name FROM sqlite_master WHERE type='table'");
            const tableNames = rows.map((r) => r.name);

            for (const expectedTable of TABLES) {
                assert.ok(tableNames.includes(expectedTable), `Table ${expectedTable} should exist`);
            }
        });

        it('does NOT have a parallel sources column in any table (BR-06)', () => {
            initSchema(db);
            for (const tbl of TABLES) {
                const cols = db.all(`PRAGMA table_info(${tbl})`).map((c) => c.name);
                assert.ok(!cols.includes('sources'), `Table ${tbl} must NOT contain 'sources' column (BR-06)`);
            }
        });
    });

    describe('BR-06: source_claim append-only enforcement', () => {
        beforeEach(() => {
            initSchema(db);
        });

        it('allows INSERT into source_claim', () => {
            db.run(
                `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
                 VALUES ('n1', 'proj-1', 'file', 'index.js', 'src/index.js', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')`
            );
            assert.doesNotThrow(() => {
                db.run(
                    `INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at)
                     VALUES ('c1', 'proj-1', 'n1', 'ast_declaration', '{"exports":["default"]}', '2026-11-03T00:00:00Z')`
                );
            });
            const claim = db.get("SELECT * FROM source_claim WHERE id = 'c1'");
            assert.equal(claim.id, 'c1');
        });

        it('prohibits UPDATE on source_claim and aborts with BR-06 error', () => {
            db.run(
                `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
                 VALUES ('n1', 'proj-1', 'file', 'index.js', 'src/index.js', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')`
            );
            db.run(
                `INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at)
                     VALUES ('c1', 'proj-1', 'n1', 'ast_declaration', '{"exports":["default"]}', '2026-11-03T00:00:00Z')`
            );
            assert.throws(() => {
                db.run("UPDATE source_claim SET claim_type = 'modified' WHERE id = 'c1'");
            }, /BR-06/);
        });

        it('prohibits DELETE on source_claim and aborts with BR-06 error', () => {
            db.run(
                `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
                 VALUES ('n1', 'proj-1', 'file', 'index.js', 'src/index.js', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')`
            );
            db.run(
                `INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at)
                     VALUES ('c1', 'proj-1', 'n1', 'ast_declaration', '{"exports":["default"]}', '2026-11-03T00:00:00Z')`
            );
            assert.throws(() => {
                db.run("DELETE FROM source_claim WHERE id = 'c1'");
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
        beforeEach(() => {
            initSchema(db);
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)\n                    VALUES ('f1', 'project-alpha', 'file', 'app.js', 'src/app.js', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)\n                    VALUES ('f2', 'project-alpha', 'file', 'util.js', 'src/util.js', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)\n                    VALUES ('fb1', 'project-beta', 'file', 'beta.js', 'src/beta.js', '2026-11-03', '2026-11-03')`);
        });

        it('returns file list and completeness for the queried project only', () => {
            const res = queryGraphFiles(db, {
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

        it('isolates data between projects (INV-GR-03)', () => {
            const resBeta = queryGraphFiles(db, {
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
            it('returns coverage 0 and status unknown when manifestEntries is empty', () => {
                const result = extractProjectGraph('test-proj', 'build-001', []);
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

            it('returns coverage 0 and status unknown when manifestEntries is null or undefined', () => {
                const result = extractProjectGraph('test-proj', null, null);
                assert.equal(result.coverage, 0);
                assert.equal(result.status, 'unknown');
            });
        });

        describe('AC-ARCH-01-06: Parse Error Isolation & Partial Coverage', () => {
            it('isolates failed file, continues parsing valid files, and records failedFiles', () => {
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

                const result = extractProjectGraph('test-proj', 'b2', manifest);

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

            it('catches and isolates exceptions thrown by custom parser', () => {
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

                const result = extractProjectGraph('test-proj', 'b3', manifest, options);
                assert.equal(result.coverage, 0.5);
                assert.equal(result.status, 'unknown');
                assert.deepEqual(result.failedFiles, ['src/crasher.js']);
                assert.equal(result.node_count, 2);
            });
        });

        describe('Idempotency & Invariants (INV-GR-01, INV-GR-02, INV-GR-03)', () => {
            it('is idempotent: running multiple times yields identical node count and IDs', () => {
                const manifest = [
                    { path: 'src/a.js', symbols: ['A1', 'A2'] },
                    { path: 'src/b.js', symbols: ['B1'] },
                ];

                const run1 = extractProjectGraph('proj-idem', 'b1', manifest);
                const run2 = extractProjectGraph('proj-idem', 'b1', manifest);

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

            it('persists idempotently to database when db option provided', () => {
                initSchema(db);
                const manifest = [
                    { path: 'src/main.js', symbols: ['start'] },
                ];

                const res1 = extractProjectGraph('proj-db', 'b1', manifest, { db });
                assert.equal(res1.node_count, 2);

                const res2 = extractProjectGraph('proj-db', 'b1', manifest, { db });
                assert.equal(res2.node_count, 2);

                const dbRows = db.all("SELECT * FROM graph_node WHERE project = 'proj-db'");
                assert.equal(dbRows.length, 2);
            });

            it('prohibits execution on turn path (INV-GR-01)', () => {
                assert.throws(() => {
                    extractProjectGraph('proj-turn', 'b1', ['src/a.js'], { onTurnPath: true });
                }, /INV-GR-01/);
            });
        });
    });

    describe('Ticket ESO-50: Q1 Read-Set Traversal (US-ARCH-02 / Slice S1)', () => {
        beforeEach(() => {
            initSchema(db);
        });

        it('AC-ARCH-02-01: returns read set with BFS traversal depth <= 2 and does not exceed depth 2', () => {
            // Setup 4 nodes across 4 files chained: Target -> n1 -> n2 -> n3
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('node_target', 'p1', 'class', 'TargetService', 'src/target.js', '2026-11-03', '2026-11-03'),
                ('node_n1', 'p1', 'class', 'Level1Consumer', 'src/consumer1.js', '2026-11-03', '2026-11-03'),
                ('node_n2', 'p1', 'class', 'Level2Consumer', 'src/consumer2.js', '2026-11-03', '2026-11-03'),
                ('node_n3', 'p1', 'class', 'Level3Consumer', 'src/consumer3.js', '2026-11-03', '2026-11-03')`);

            // Edges:
            // Level 1: node_n1 references node_target (depth 1)
            // Level 2: node_n2 references node_n1 (depth 2)
            // Level 3: node_n3 references node_n2 (depth 3 - MUST NOT be in readSet)
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e1', 'p1', 'node_n1', 'node_target', 'references', '2026-11-03'),
                ('e2', 'p1', 'node_n2', 'node_n1', 'references', '2026-11-03'),
                ('e3', 'p1', 'node_n3', 'node_n2', 'references', '2026-11-03')`);

            const res = queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'TargetService',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.project, 'p1');
            assert.equal(res.depth, 2);
            assert.equal(res.capped, false);
            assert.equal(res.totalFound, 2);
            assert.deepEqual(res.readSet, ['src/consumer1.js', 'src/consumer2.js']);
            assert.ok(!res.readSet.includes('src/consumer3.js'), 'Depth 3 file must NOT be included (AC-ARCH-02-01)');
            assert.ok(!res.readSet.includes('src/target.js'), 'Origin target file must NOT be in dependent read set');
        });

        it('AC-ARCH-02-02: returns status unknown and attaches coverage when completeness < threshold', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('s1', 'p1', 'symbol', 'fnCore', 'src/core.js', '2026-11-03', '2026-11-03'),
                ('s2', 'p1', 'symbol', 'fnCaller', 'src/caller.js', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e1', 'p1', 's2', 's1', 'references', '2026-11-03')`);

            // completeness = 0.85 (above floor 0.80, below threshold 0.90)
            const res = queryReadSet(db, {
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

        it('AC-ARCH-02-03: refuses to answer (status: REFUSED, error: NO_COVERAGE) when coverage is missing, zero, below floor, or input missing', () => {
            // 1. Missing project
            const missingProj = queryReadSet(db, { symbolOrFile: 'fnA' });
            assert.equal(missingProj.status, 'REFUSED');
            assert.equal(missingProj.error, 'NO_COVERAGE');

            // 2. Missing symbolOrFile
            const missingSymbol = queryReadSet(db, { project: 'p1' });
            assert.equal(missingSymbol.status, 'REFUSED');
            assert.equal(missingSymbol.error, 'NO_COVERAGE');

            // 3. No coverage available in options or db
            const noCoverage = queryReadSet(db, { project: 'p1', symbolOrFile: 'fnA' });
            assert.equal(noCoverage.status, 'REFUSED');
            assert.equal(noCoverage.error, 'NO_COVERAGE');
            assert.deepEqual(noCoverage.readSet, []);

            // 4. Coverage below floor (0.50 < 0.80 default floor)
            const belowFloor = queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'fnA',
                completeness: 0.50,
            });
            assert.equal(belowFloor.status, 'REFUSED');
            assert.equal(belowFloor.error, 'NO_COVERAGE');
        });

        it('AC-ARCH-02-04: returns empty read set without error for isolated symbol with 0 references', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('s_iso', 'p1', 'symbol', 'isolatedFn', 'src/isolated.js', '2026-11-03', '2026-11-03')`);

            const res = queryReadSet(db, {
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

        it('AC-ARCH-02-05: caps read set when results exceed maxFanout, returning capped: true and totalFound: N', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('node_hub', 'p1', 'class', 'HubService', 'src/hub.js', '2026-11-03', '2026-11-03')`);

            // Insert 6 consumer files
            for (let i = 1; i <= 6; i++) {
                db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                    ('c_${i}', 'p1', 'file', 'consumer_${i}.js', 'src/consumer_${i}.js', '2026-11-03', '2026-11-03')`);
                db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                    ('e_${i}', 'p1', 'c_${i}', 'node_hub', 'references', '2026-11-03')`);
            }

            // Set maxFanout = 4
            const res = queryReadSet(db, {
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

        it('INV-GR-01: strictly ignores fabricated edge relations not in references, maps_to, declares', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('sym_a', 'p1', 'symbol', 'realSymbol', 'src/a.js', '2026-11-03', '2026-11-03'),
                ('sym_real', 'p1', 'symbol', 'realConsumer', 'src/real.js', '2026-11-03', '2026-11-03'),
                ('sym_fake', 'p1', 'symbol', 'fakeConsumer', 'src/fake.js', '2026-11-03', '2026-11-03')`);

            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_real', 'p1', 'sym_real', 'sym_a', 'references', '2026-11-03'),
                ('e_fake', 'p1', 'sym_fake', 'sym_a', 'fabricated_call', '2026-11-03')`);

            const res = queryReadSet(db, {
                project: 'p1',
                symbolOrFile: 'realSymbol',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.deepEqual(res.readSet, ['src/real.js']);
            assert.ok(!res.readSet.includes('src/fake.js'), 'Fabricated edge relation must NOT be traversed (INV-GR-01)');
        });

        it('INV-GR-03: enforces project isolation in graph traversal', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('sym_x', 'proj-alpha', 'symbol', 'sharedName', 'src/x.js', '2026-11-03', '2026-11-03'),
                ('sym_alpha_caller', 'proj-alpha', 'symbol', 'alphaCaller', 'src/alpha_caller.js', '2026-11-03', '2026-11-03'),
                ('sym_beta_caller', 'proj-beta', 'symbol', 'betaCaller', 'src/beta_caller.js', '2026-11-03', '2026-11-03')`);

            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_alpha', 'proj-alpha', 'sym_alpha_caller', 'sym_x', 'references', '2026-11-03'),
                ('e_beta', 'proj-beta', 'sym_beta_caller', 'sym_x', 'references', '2026-11-03')`);

            const res = queryReadSet(db, {
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
        beforeEach(() => {
            initSchema(db);
        });

        it('AC-ARCH-03-01: returns reverse-dependency impact chain entity -> dto -> app_service', () => {
            // Setup schema nodes
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('tbl_orders', 'p1', 'table', 'orders', 'db/orders.sql', '2026-11-03', '2026-11-03'),
                ('ent_order', 'p1', 'entity', 'OrderEntity', 'src/entities/order.entity.ts', '2026-11-03', '2026-11-03'),
                ('dto_order', 'p1', 'dto', 'OrderResponseDto', 'src/dtos/order.dto.ts', '2026-11-03', '2026-11-03'),
                ('svc_order', 'p1', 'app_service', 'OrderAppService', 'src/services/order.service.ts', '2026-11-03', '2026-11-03')`);

            // Setup edges (reverse dependencies)
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e1', 'p1', 'ent_order', 'tbl_orders', 'maps_to', '2026-11-03'),
                ('e2', 'p1', 'dto_order', 'ent_order', 'references', '2026-11-03'),
                ('e3', 'p1', 'svc_order', 'dto_order', 'references', '2026-11-03')`);

            const res = queryColumnImpact(db, {
                project: 'p1',
                table: 'orders',
                column: 'status',
                completeness: 0.95,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.project, 'p1');
            assert.equal(res.table, 'orders');
            assert.equal(res.impactChain.length, 3);

            // Step 1: entity, Step 2: dto, Step 3: app_service (0 forward relations)
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

        it('AC-ARCH-03-02 & BR-05: returns status unknown and LOW_COVERAGE when coverage is low, never "không gãy gì"', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('tbl_users', 'p1', 'table', 'users', 'db/users.sql', '2026-11-03', '2026-11-03'),
                ('ent_user', 'p1', 'entity', 'UserEntity', 'src/user.entity.ts', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_u', 'p1', 'ent_user', 'tbl_users', 'maps_to', '2026-11-03')`);

            // coverage = 0.82 (between floor 0.80 and threshold 0.90)
            const res = queryColumnImpact(db, {
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

        it('AC-ARCH-03-03: refuses with OVERREACH when candidate files not depending on the table are included', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('tbl_items', 'p1', 'table', 'items', 'db/items.sql', '2026-11-03', '2026-11-03'),
                ('ent_item', 'p1', 'entity', 'ItemEntity', 'src/item.entity.ts', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_item', 'p1', 'ent_item', 'tbl_items', 'maps_to', '2026-11-03')`);

            // Candidates list contains a completely unrelated file
            const res = queryColumnImpact(db, {
                project: 'p1',
                table: 'items',
                completeness: 1.0,
                candidates: ['src/item.entity.ts', 'src/unrelated/logger.ts'],
            });

            assert.equal(res.status, 'REFUSED');
            assert.equal(res.error, 'OVERREACH');
            assert.deepEqual(res.invalidFiles, ['src/unrelated/logger.ts']);
        });

        it('AC-ARCH-03-04: unread table returns empty impact list without OVERREACH', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('tbl_audit_log', 'p1', 'table', 'audit_logs', 'db/audit.sql', '2026-11-03', '2026-11-03')`);

            const res = queryColumnImpact(db, {
                project: 'p1',
                table: 'audit_logs',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.deepEqual(res.impactChain, []);
            assert.deepEqual(res.impactedFiles, []);
            assert.deepEqual(res.unknowns, []);
        });

        it('AC-ARCH-03-05: entity pointing to deleted table returns status unknown with DANGLING_TABLE', () => {
            // Note: Table 'legacy_table' is deleted, but entity exists and has a source_claim / metadata mapping to it
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
                ('ent_legacy', 'p1', 'entity', 'LegacyEntity', 'src/legacy.entity.ts', '{"targetTable":"legacy_table"}', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at) VALUES
                ('claim_dang', 'p1', 'ent_legacy', 'maps_to', '{"table":"legacy_table"}', '2026-11-03')`);

            const res = queryColumnImpact(db, {
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
        beforeEach(() => {
            initSchema(db);
        });

        it('AC-ARCH-04-01: detects real SCC cycles (modA -> modB -> modA)', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('mod_auth', 'p1', 'module', 'AuthModule', 'src/auth/auth.module.ts', '2026-11-03', '2026-11-03'),
                ('mod_user', 'p1', 'module', 'UserModule', 'src/user/user.module.ts', '2026-11-03', '2026-11-03')`);

            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e1', 'p1', 'mod_auth', 'mod_user', 'depends_on', '2026-11-03'),
                ('e2', 'p1', 'mod_user', 'mod_auth', 'depends_on', '2026-11-03')`);

            const res = queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, true);
            assert.equal(res.cycles.length, 1);
            assert.ok(res.cycles[0].includes('AuthModule'));
            assert.ok(res.cycles[0].includes('UserModule'));
        });

        it('AC-ARCH-04-02: does not report false cycle on shared dependency diamond (modA -> modC, modB -> modC)', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('mod_order', 'p1', 'module', 'OrderModule', 'src/order/order.module.ts', '2026-11-03', '2026-11-03'),
                ('mod_payment', 'p1', 'module', 'PaymentModule', 'src/payment/payment.module.ts', '2026-11-03', '2026-11-03'),
                ('mod_common', 'p1', 'module', 'CommonModule', 'src/common/common.module.ts', '2026-11-03', '2026-11-03')`);

            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_o_c', 'p1', 'mod_order', 'mod_common', 'depends_on', '2026-11-03'),
                ('e_p_c', 'p1', 'mod_payment', 'mod_common', 'depends_on', '2026-11-03')`);

            const res = queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.deepEqual(res.cycles, []);
        });

        it('AC-ARCH-04-03 & BR-05: completeness < 0.70 returns status unknown and LOW_COVERAGE, never claims clean', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('mod_x', 'p1', 'module', 'ModX', 'src/x.module.ts', '2026-11-03', '2026-11-03'),
                ('mod_y', 'p1', 'module', 'ModY', 'src/y.module.ts', '2026-11-03', '2026-11-03')`);
            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_xy', 'p1', 'mod_x', 'mod_y', 'depends_on', '2026-11-03')`);

            const res = queryCircularDependencies(db, {
                project: 'p1',
                completeness: 0.65, // < 0.70
            });

            assert.equal(res.status, 'unknown');
            assert.notEqual(res.status, 'ready');
            assert.equal(res.error, 'LOW_COVERAGE');
            assert.equal(res.coverage, 0.65);
        });

        it('AC-ARCH-04-04: graph with 0 depends_on edges explicitly says "không có vòng" with completeness', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
                ('mod_standalone', 'p1', 'module', 'StandaloneModule', 'src/mod.ts', '2026-11-03', '2026-11-03')`);

            const res = queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.deepEqual(res.cycles, []);
            assert.ok(res.message.includes('không có vòng'));
            assert.equal(res.coverage, 1.0);
        });

        it('AC-ARCH-04-05: prunes dangling depends_on edge to deleted module without false positive cycle', () => {
            db.run(`INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
                ('mod_active', 'p1', 'module', 'ActiveModule', 'src/active.ts', '{}', '2026-11-03', '2026-11-03'),
                ('mod_deleted', 'p1', 'module', 'DeletedModule', 'src/deleted.ts', '{"deleted":true}', '2026-11-03', '2026-11-03')`);

            db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
                ('e_dang_mod', 'p1', 'mod_active', 'mod_deleted', 'depends_on', '2026-11-03')`);

            const res = queryCircularDependencies(db, {
                project: 'p1',
                completeness: 1.0,
            });

            assert.equal(res.status, 'ready');
            assert.equal(res.hasCycles, false);
            assert.equal(res.unknowns.length, 1);
            assert.equal(res.unknowns[0].type, 'DANGLING_MODULE');
            assert.equal(res.unknowns[0].targetModule, 'DeletedModule');
        });
    });
});
