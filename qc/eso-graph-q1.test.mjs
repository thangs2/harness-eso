import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initSchema,
    queryReadSet,
    DEFAULT_THRESHOLD,
    DEFAULT_FLOOR,
    DEFAULT_MAX_FANOUT,
} from '../eso/graph/src/index.mjs';

function createDb() {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        all: (sql, params = []) => rawDb.query(sql).all(...params),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
        get: (sql, params = []) => rawDb.query(sql).get(...params),
    };
    initSchema(db);
    return db;
}

test('SCN-ARCH-05 (AC-ARCH-02-01 & INV-GR-01): Q1 read set traversed to depth <= 2 only', () => {
    const db = createDb();
    const project = 'proj-depth-test';

    // Graph setup:
    // depth 0: TargetSymbol (file: src/target.ts)
    // depth 1: CallerA (src/caller_a.ts) -> references TargetSymbol
    // depth 2: CallerB (src/caller_b.ts) -> references CallerA
    // depth 3: CallerC (src/caller_c.ts) -> references CallerB (must NOT be included in read set)
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_target', '${project}', 'symbol', 'TargetSymbol', 'src/target.ts', '2026-11-03', '2026-11-03'),
        ('n_caller_a', '${project}', 'symbol', 'CallerA', 'src/caller_a.ts', '2026-11-03', '2026-11-03'),
        ('n_caller_b', '${project}', 'symbol', 'CallerB', 'src/caller_b.ts', '2026-11-03', '2026-11-03'),
        ('n_caller_c', '${project}', 'symbol', 'CallerC', 'src/caller_c.ts', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e1', '${project}', 'n_caller_a', 'n_target', 'references', '2026-11-03'),
        ('e2', '${project}', 'n_caller_b', 'n_caller_a', 'references', '2026-11-03'),
        ('e3', '${project}', 'n_caller_c', 'n_caller_b', 'references', '2026-11-03')`);

    const res = queryReadSet(db, {
        project,
        symbolOrFile: 'TargetSymbol',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.project, project);
    assert.equal(res.depth, 2);
    // Should include src/caller_a.ts (depth 1) and src/caller_b.ts (depth 2), but NOT src/caller_c.ts (depth 3)
    assert.ok(res.readSet.includes('src/caller_a.ts'), 'depth 1 file must be in read set');
    assert.ok(res.readSet.includes('src/caller_b.ts'), 'depth 2 file must be in read set');
    assert.ok(!res.readSet.includes('src/caller_c.ts'), 'depth 3 file must NOT be in read set (AC-ARCH-02-01: depth <= 2)');
    assert.equal(res.readSet.length, 2);
});

test('SCN-ARCH-06 (AC-ARCH-02-02 & BR-05): Completeness < threshold returns unknown with coverage percentage, never absent', () => {
    const db = createDb();
    const project = 'proj-coverage-test';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_svc', '${project}', 'symbol', 'OrderService', 'src/order.ts', '2026-11-03', '2026-11-03')`);

    // completeness = 0.85 (below default threshold 0.90, but >= default floor 0.80)
    const res = queryReadSet(db, {
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
});

test('SCN-ARCH-22 (AC-ARCH-02-03): Refuses to answer with NO_COVERAGE on missing/low completeness or invalid input', () => {
    const db = createDb();
    const project = 'proj-refusal-test';

    // 1. Missing coverage
    const resNoCoverage = queryReadSet(db, {
        project,
        symbolOrFile: 'SomeSymbol',
        completeness: null,
    });
    assert.equal(resNoCoverage.status, 'REFUSED');
    assert.equal(resNoCoverage.error, 'NO_COVERAGE');

    // 2. Coverage below floor (e.g. 0.50 < 0.80 floor)
    const resSubFloor = queryReadSet(db, {
        project,
        symbolOrFile: 'SomeSymbol',
        completeness: 0.50,
        floor: 0.80,
    });
    assert.equal(resSubFloor.status, 'REFUSED');
    assert.equal(resSubFloor.error, 'NO_COVERAGE');

    // 3. Missing project or symbol
    const resNoProject = queryReadSet(db, {
        project: '',
        symbolOrFile: 'SomeSymbol',
        completeness: 1.0,
    });
    assert.equal(resNoProject.status, 'REFUSED');
    assert.equal(resNoProject.error, 'NO_COVERAGE');
});

test('SCN-ARCH-23 (AC-ARCH-02-04): Isolated symbol with 0 references returns status ready with empty read set without error', () => {
    const db = createDb();
    const project = 'proj-isolated-test';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_iso', '${project}', 'symbol', 'StandaloneUtil', 'src/util.ts', '2026-11-03', '2026-11-03')`);

    const res = queryReadSet(db, {
        project,
        symbolOrFile: 'StandaloneUtil',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.symbolOrFile, 'StandaloneUtil');
    assert.deepEqual(res.readSet, []);
    assert.equal(res.totalFound, 0);
    assert.equal(res.capped, false);
});

test('SCN-ARCH-24 (AC-ARCH-02-05): Results exceeding fanout threshold are capped with capped: true and totalFound count', () => {
    const db = createDb();
    const project = 'proj-fanout-test';

    // Target hub node
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_core', '${project}', 'symbol', 'CoreService', 'src/core.ts', '2026-11-03', '2026-11-03')`);

    // 10 callers
    for (let i = 1; i <= 10; i++) {
        db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
            ('n_c${i}', '${project}', 'file', 'client_${i}.ts', 'src/clients/client_${i}.ts', '2026-11-03', '2026-11-03')`);
        db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
            ('e_${i}', '${project}', 'n_c${i}', 'n_core', 'references', '2026-11-03')`);
    }

    const maxFanout = 5;
    const res = queryReadSet(db, {
        project,
        symbolOrFile: 'CoreService',
        completeness: 1.0,
        maxFanout,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.capped, true);
    assert.equal(res.totalFound, 10);
    assert.equal(res.readSet.length, maxFanout);
});

test('SCN-ARCH-25 (INV-GR-01 & INV-GR-03): Ignores non-standard edge relations and enforces project isolation', () => {
    const db = createDb();

    // Setup proj-A and proj-B
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_a_target', 'proj-A', 'symbol', 'BillingService', 'src/billing.ts', '2026-11-03', '2026-11-03'),
        ('n_a_caller', 'proj-A', 'file', 'caller_a.ts', 'src/caller_a.ts', '2026-11-03', '2026-11-03'),
        ('n_a_hallucinated', 'proj-A', 'file', 'hallucinated.ts', 'src/hallucinated.ts', '2026-11-03', '2026-11-03'),
        ('n_b_caller', 'proj-B', 'file', 'caller_b.ts', 'src/caller_b.ts', '2026-11-03', '2026-11-03')`);

    // Standard relation for proj-A caller
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_a_valid', 'proj-A', 'n_a_caller', 'n_a_target', 'references', '2026-11-03')`);

    // Fabricated / non-standard relation for hallucinated file (INV-GR-01)
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_a_invalid', 'proj-A', 'n_a_hallucinated', 'n_a_target', 'fabricated_link', '2026-11-03')`);

    // Leak attempt from proj-B targeting proj-A node (INV-GR-03)
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_cross', 'proj-B', 'n_b_caller', 'n_a_target', 'references', '2026-11-03')`);

    const res = queryReadSet(db, {
        project: 'proj-A',
        symbolOrFile: 'BillingService',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.deepEqual(res.readSet, ['src/caller_a.ts']);
    assert.ok(!res.readSet.includes('src/hallucinated.ts'), 'INV-GR-01: Fabricated edge relation must NOT be traversed');
    assert.ok(!res.readSet.includes('src/caller_b.ts'), 'INV-GR-03: proj-B caller must NOT leak into proj-A read set');
});
