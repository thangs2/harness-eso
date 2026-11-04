import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initSchema, queryReadSet, calculateCompleteness, extractProjectGraph } from '../eso/graph/src/index.mjs';

function createDb() {
    const db = createDbAdapter(':memory:');
    initSchema(db);
    return db;
}

test('ESO-384 (B6): missing or invalid db throws error instead of silent empty ready return', () => {
    assert.throws(() => {
        queryReadSet(null, {
            project: 'proj-1',
            symbolOrFile: 'MyClass',
            completeness: 1.0,
        });
    }, /Database instance is required/);

    assert.throws(() => {
        queryReadSet({}, {
            project: 'proj-1',
            symbolOrFile: 'MyClass',
            completeness: 1.0,
        });
    }, /Database instance must provide \.all\(\)/);
});

test('ESO-384 (B6): Q1 read-set correctly executes with db adapter on Node and returns accurate dependencies', () => {
    const db = createDb();
    const project = 'proj-precision';

    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
         ('n_target', ?, 'symbol', 'OrderProcessor', 'src/order.ts', '2026-11-04', '2026-11-04'),
         ('n_caller', ?, 'symbol', 'BillingService', 'src/billing.ts', '2026-11-04', '2026-11-04')`,
        [project, project]
    );

    db.run(
        `INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
         ('e1', ?, 'n_caller', 'n_target', 'references', '2026-11-04')`,
        [project]
    );

    const res = queryReadSet(db, {
        project,
        symbolOrFile: 'OrderProcessor',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.readSet.length, 1);
    assert.ok(res.readSet.includes('src/billing.ts'));
});

test('ESO-385: file-only graph yields unknown coverage and is not falsely reported as 100% complete', () => {
    // 1. Direct completeness calculation on file-only coverage
    const fileOnlyCoverage = {
        file: { covered: 3, total: 3 },
        class: { covered: 0, total: 0 },
        method: { covered: 0, total: 0 },
    };
    const comp = calculateCompleteness('Q1', fileOnlyCoverage);
    assert.equal(comp.status, 'unknown');
    assert.equal(comp.coverage, null, 'file-only completeness coverage must be null (unknown), NOT 1.0');
    assert.equal(comp.value, 0, 'file-only completeness value must be 0, NOT 1.0');
    assert.equal(comp.perKind.class.coverage, null);
    assert.equal(comp.perKind.class.status, 'unknown');
    assert.equal(comp.perKind.method.coverage, null);
    assert.equal(comp.perKind.method.status, 'unknown');

    // 2. Extractor with file-only manifest
    const fileOnlyManifest = [
        { path: 'src/config.ts' },
        { path: 'src/constants.ts' },
    ];
    const extractResult = extractProjectGraph('project-file-only', 'build-1', fileOnlyManifest);
    assert.equal(extractResult.status, 'unknown');
    assert.notEqual(extractResult.coverage, 1.0, 'must not falsely report 100% coverage');
    assert.equal(extractResult.coverage, null, 'must report unknown coverage');
    assert.equal(extractResult.completeness.status, 'unknown');
    assert.equal(extractResult.completeness.perKind.class.coverage, null);
    assert.equal(extractResult.completeness.perKind.method.coverage, null);

    // 3. Q1 readSet query with file-only completeness refuses
    const db = createDb();
    const q1Res = queryReadSet(db, {
        project: 'project-file-only',
        symbolOrFile: 'src/config.ts',
        completeness: comp,
    });
    assert.notEqual(q1Res.status, 'ready', 'Q1 must not be ready when completeness is unknown / no coverage');
    assert.equal(q1Res.status, 'REFUSED');
    assert.equal(q1Res.error, 'NO_COVERAGE');
});

test('ESO-385: graph with actual classes and methods computes reasonable coverage', () => {
    // 1. Manifest with extracted classes and methods
    const manifestWithSymbols = [
        {
            path: 'src/services/user.ts',
            symbols: [
                { name: 'UserService', kind: 'class' },
                { name: 'getUser', kind: 'method' },
            ],
        },
        {
            path: 'src/services/auth.ts',
            symbols: [
                { name: 'AuthService', kind: 'class' },
                { name: 'login', kind: 'method' },
                { name: 'logout', kind: 'method' },
            ],
        },
    ];

    const extractResult = extractProjectGraph('project-symbols', 'build-2', manifestWithSymbols);
    assert.equal(extractResult.status, 'ready');
    assert.equal(extractResult.coverage, 1.0);
    assert.equal(extractResult.completeness.status, 'ready');
    assert.equal(extractResult.completeness.perKind.file.coverage, 1.0);
    assert.equal(extractResult.completeness.perKind.class.coverage, 1.0);
    assert.equal(extractResult.completeness.perKind.class.covered, 2);
    assert.equal(extractResult.completeness.perKind.class.total, 2);
    assert.equal(extractResult.completeness.perKind.method.coverage, 1.0);
    assert.equal(extractResult.completeness.perKind.method.covered, 3);
    assert.equal(extractResult.completeness.perKind.method.total, 3);

    // 2. Partial coverage with classes and methods
    const manifestPartial = [
        {
            path: 'src/services/user.ts',
            symbols: [
                { name: 'UserService', kind: 'class' },
                { name: 'getUser', kind: 'method' },
            ],
        },
        {
            path: 'src/services/corrupted.ts',
            parseError: true,
            error: new Error('Syntax error'),
            symbols: [
                { name: 'BadService', kind: 'class' },
            ],
        },
    ];

    const partialResult = extractProjectGraph('project-partial', 'build-3', manifestPartial);
    assert.equal(partialResult.status, 'unknown');
    assert.equal(partialResult.completeness.status, 'unknown');
    assert.equal(partialResult.completeness.perKind.file.covered, 1);
    assert.equal(partialResult.completeness.perKind.file.total, 2);
    assert.equal(partialResult.completeness.perKind.class.covered, 1);
    assert.equal(partialResult.completeness.perKind.class.total, 2);
    assert.equal(partialResult.completeness.perKind.class.coverage, 0.5);
    assert.equal(partialResult.completeness.perKind.method.covered, 1);
    assert.equal(partialResult.completeness.perKind.method.total, 1);
    assert.equal(partialResult.completeness.perKind.method.coverage, 1.0);
    assert.equal(partialResult.coverage, 0.5);
});
