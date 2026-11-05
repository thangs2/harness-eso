import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryReadSet,
    DEFAULT_THRESHOLD,
    DEFAULT_FLOOR,
    DEFAULT_MAX_FANOUT,
} from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('SCN-ARCH-05 (AC-ARCH-02-01 & INV-GR-01): Q1 read set traversed to depth <= 2 only on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-depth-test';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_target', 'method', 'TargetSymbol', 'src/target.ts'),
            ('${project}', 'b1', 'n_caller_a', 'method', 'CallerA', 'src/caller_a.ts'),
            ('${project}', 'b1', 'n_caller_b', 'method', 'CallerB', 'src/caller_b.ts'),
            ('${project}', 'b1', 'n_caller_c', 'method', 'CallerC', 'src/caller_c.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e1', 'n_caller_a', 'n_target', 'references', false),
            ('${project}', 'b1', 'e2', 'n_caller_b', 'n_caller_a', 'references', false),
            ('${project}', 'b1', 'e3', 'n_caller_c', 'n_caller_b', 'references', false)`);

        const res = await queryReadSet(db, {
            project,
            symbolOrFile: 'TargetSymbol',
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.project, project);
        assert.equal(res.depth, 2);
        assert.ok(res.readSet.includes('src/caller_a.ts'), 'depth 1 file must be in read set');
        assert.ok(res.readSet.includes('src/caller_b.ts'), 'depth 2 file must be in read set');
        assert.ok(!res.readSet.includes('src/caller_c.ts'), 'depth 3 file must NOT be in read set (AC-ARCH-02-01: depth <= 2)');
        assert.equal(res.readSet.length, 2);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-06 (AC-ARCH-02-02 & BR-05): Completeness < threshold returns unknown with coverage percentage, never absent', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-coverage-test';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_svc', 'class', 'OrderService', 'src/order.ts')`);

        const res = await queryReadSet(db, {
            project,
            symbolOrFile: 'OrderService',
            completeness: 0.85,
        });

        assert.equal(res.status, 'unknown');
        assert.notEqual(res.status, 'absent', 'BR-05: Incomplete graph must report status unknown, NEVER absent');
        assert.equal(res.coverage, 0.85);
        assert.equal(res.completeness.status, 'unknown');
        assert.equal(res.completeness.value, 0.85);
        assert.ok(Array.isArray(res.readSet), 'readSet array is still returned for inspection');
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-22 (AC-ARCH-02-03): Refuses to answer with NO_COVERAGE on missing/low completeness or invalid input', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-refusal-test';

    try {
        const resNoCoverage = await queryReadSet(db, {
            project,
            symbolOrFile: 'SomeSymbol',
            completeness: null,
        });
        assert.equal(resNoCoverage.status, 'REFUSED');
        assert.equal(resNoCoverage.error, 'NO_COVERAGE');

        const resSubFloor = await queryReadSet(db, {
            project,
            symbolOrFile: 'SomeSymbol',
            completeness: 0.50,
            floor: 0.80,
        });
        assert.equal(resSubFloor.status, 'REFUSED');
        assert.equal(resSubFloor.error, 'NO_COVERAGE');

        const resNoProject = await queryReadSet(db, {
            project: '',
            symbolOrFile: 'SomeSymbol',
            completeness: 1.0,
        });
        assert.equal(resNoProject.status, 'REFUSED');
        assert.equal(resNoProject.error, 'NO_COVERAGE');
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-23 (AC-ARCH-02-04): Isolated symbol with 0 references returns status ready with empty read set without error', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-isolated-test';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_iso', 'method', 'StandaloneUtil', 'src/util.ts')`);

        const res = await queryReadSet(db, {
            project,
            symbolOrFile: 'StandaloneUtil',
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.symbolOrFile, 'StandaloneUtil');
        assert.deepEqual(res.readSet, []);
        assert.equal(res.totalFound, 0);
        assert.equal(res.capped, false);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-24 (AC-ARCH-02-05): Results exceeding fanout threshold are capped with capped: true and totalFound count', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-fanout-test';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_core', 'class', 'CoreService', 'src/core.ts')`);

        for (let i = 1; i <= 10; i++) {
            await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
                ('${project}', 'b1', 'n_c${i}', 'module', 'client_${i}.ts', 'src/clients/client_${i}.ts')`);
            await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
                ('${project}', 'b1', 'e_${i}', 'n_c${i}', 'n_core', 'references', false)`);
        }

        const maxFanout = 5;
        const res = await queryReadSet(db, {
            project,
            symbolOrFile: 'CoreService',
            completeness: 1.0,
            maxFanout,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.capped, true);
        assert.equal(res.totalFound, 10);
        assert.equal(res.readSet.length, maxFanout);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-25 (INV-GR-01 & INV-GR-03): Ignores non-standard edge relations and enforces project isolation', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('proj-A', 'b1', 'n_a_target', 'class', 'BillingService', 'src/billing.ts'),
            ('proj-A', 'b1', 'n_a_caller', 'module', 'caller_a.ts', 'src/caller_a.ts'),
            ('proj-A', 'b1', 'n_a_hallucinated', 'module', 'hallucinated.ts', 'src/hallucinated.ts'),
            ('proj-B', 'b1', 'n_b_caller', 'module', 'caller_b.ts', 'src/caller_b.ts'),
            ('proj-B', 'b1', 'n_b_target', 'class', 'BillingService', 'src/billing.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('proj-A', 'b1', 'e_a_valid', 'n_a_caller', 'n_a_target', 'references', false)`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('proj-A', 'b1', 'e_a_invalid', 'n_a_hallucinated', 'n_a_target', 'specifies', false)`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('proj-B', 'b1', 'e_cross', 'n_b_caller', 'n_b_target', 'references', false)`);

        const res = await queryReadSet(db, {
            project: 'proj-A',
            symbolOrFile: 'BillingService',
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.deepEqual(res.readSet, ['src/caller_a.ts']);
        assert.ok(!res.readSet.includes('src/hallucinated.ts'), 'INV-GR-01: Non-readset relation must NOT be traversed');
        assert.ok(!res.readSet.includes('src/caller_b.ts'), 'INV-GR-03: proj-B caller must NOT leak into proj-A read set');
    } finally {
        await pg.cleanup();
    }
});
