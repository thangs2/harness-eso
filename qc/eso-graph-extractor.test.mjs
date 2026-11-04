import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { initSchema, generateNodeId, extractProjectGraph } from '../eso/graph/src/index.mjs';

test('SCN-ARCH-04 (AC-ARCH-01-04): Node IDs are deterministic across repeated extractions and enforce project boundary', () => {
    // 1. Same inputs always yield the same node ID
    const idA1 = generateNodeId('tenant-p1', 'file', 'services/order.ts');
    const idA2 = generateNodeId('tenant-p1', 'file', 'services/order.ts');
    assert.equal(idA1, idA2);
    assert.ok(idA1.startsWith('node_'));

    // 2. Different symbols in the same file get distinct IDs
    const classId = generateNodeId('tenant-p1', 'class', 'services/order.ts', 'OrderService');
    const methodId = generateNodeId('tenant-p1', 'method', 'services/order.ts', 'createOrder');
    assert.notEqual(idA1, classId);
    assert.notEqual(classId, methodId);

    // 3. Different projects yield different IDs for identical relative paths (INV-GR-03)
    const idB = generateNodeId('tenant-p2', 'file', 'services/order.ts');
    assert.notEqual(idA1, idB);
});

test('SCN-ARCH-20 (AC-ARCH-01-05 & BR-05): Empty manifest or unextracted yields coverage=0 and unknown, never absent', () => {
    // 1. Empty manifest
    const emptyRes = extractProjectGraph('project-blank', 'build-101', []);

    assert.equal(emptyRes.project, 'project-blank');
    assert.equal(emptyRes.buildId, 'build-101');
    assert.equal(emptyRes.coverage, 0);
    assert.equal(emptyRes.status, 'unknown');
    assert.notEqual(emptyRes.status, 'absent', 'BR-05: incomplete / unextracted must report unknown, NEVER absent');
    assert.equal(emptyRes.scannedNodesCount, 0);
    assert.equal(emptyRes.node_count, 0);
    assert.deepEqual(emptyRes.nodes, []);
    assert.deepEqual(emptyRes.edges, []);
});

test('SCN-ARCH-21 (AC-ARCH-01-06 & BR-05): File parse error is isolated; partial coverage and node count recorded', () => {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        all: (sql, params = []) => rawDb.query(sql).all(...params),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
    };
    initSchema(db);

    const manifestWithCorruptedFile = [
        {
            path: 'src/modules/auth.ts',
            symbols: [{ name: 'AuthModule', kind: 'class' }, { name: 'login', kind: 'method' }]
        },
        {
            path: 'src/modules/corrupted.ts',
            parseError: true,
            error: new Error('Unexpected token at line 42')
        },
        {
            path: 'src/modules/payment.ts',
            symbols: [{ name: 'PaymentService', kind: 'class' }]
        }
    ];

    const extractResult = extractProjectGraph('project-fintech', 'build-v1', manifestWithCorruptedFile, { db });

    // 1. Partial coverage: 2 valid out of 3 total files = ~0.6667
    assert.equal(extractResult.coverage, 0.6667);
    assert.equal(extractResult.status, 'unknown');
    assert.notEqual(extractResult.status, 'absent');

    // 2. Failed file is isolated and logged
    assert.deepEqual(extractResult.failedFiles, ['src/modules/corrupted.ts']);
    assert.equal(extractResult.errors.length, 1);
    assert.ok(extractResult.errors[0].error.includes('Unexpected token'));

    // 3. Valid files and symbols are properly scanned and persisted
    // auth.ts (1 file + 2 symbols) + payment.ts (1 file + 1 symbol) = 5 nodes
    assert.equal(extractResult.node_count, 5);
    assert.equal(extractResult.scannedNodesCount, 5);
    assert.equal(extractResult.nodes.length, 5);

    // 4. Database reflects exactly the scanned nodes for the project (INV-GR-03)
    const persistedNodes = db.all("SELECT * FROM graph_node WHERE project = 'project-fintech'");
    assert.equal(persistedNodes.length, 5);
    assert.ok(!persistedNodes.some(n => n.path === 'src/modules/corrupted.ts'));

    // 5. Execution on turn-path is prohibited (INV-GR-01)
    assert.throws(() => {
        extractProjectGraph('project-fintech', 'build-v1', manifestWithCorruptedFile, { onTurnPath: true });
    }, /INV-GR-01/);
});
