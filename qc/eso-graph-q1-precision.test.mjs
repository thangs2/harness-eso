import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initSchema, queryReadSet } from '../eso/graph/src/index.mjs';

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
