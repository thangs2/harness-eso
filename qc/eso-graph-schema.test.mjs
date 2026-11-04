import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { initSchema, TABLES, queryGraphFiles } from '../eso/graph/src/index.mjs';

test('SCN-ARCH-01 (AC-ARCH-01-01): Warm graph queries return file list with completeness and project isolation', () => {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        all: (sql, params = []) => rawDb.query(sql).all(...params),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
    };

    // 1. DDL initialization and idempotency (running twice produces no error)
    initSchema(db);
    initSchema(db);

    const tablesInDb = db.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name);
    for (const tbl of TABLES) {
        assert.ok(tablesInDb.includes(tbl), `Table ${tbl} must exist`);
    }

    // 2. Insert test graph nodes for two different projects
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
         VALUES ('node-1', 'proj-alpha', 'file', 'order.service.ts', 'src/order.service.ts', '2026-11-03', '2026-11-03')`
    );
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
         VALUES ('node-2', 'proj-alpha', 'file', 'order.controller.ts', 'src/order.controller.ts', '2026-11-03', '2026-11-03')`
    );
    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
         VALUES ('node-3', 'proj-beta', 'file', 'billing.ts', 'src/billing.ts', '2026-11-03', '2026-11-03')`
    );

    // 3. Query files for proj-alpha with 100% warm coverage
    const resAlpha = queryGraphFiles(db, {
        project: 'proj-alpha',
        question: 'Q1',
        perKindCoverage: { file: 1.0, class: 1.0, method: 1.0 }
    });

    assert.equal(resAlpha.project, 'proj-alpha');
    assert.equal(resAlpha.files.length, 2);
    assert.deepEqual(resAlpha.files.map(f => f.name), ['order.controller.ts', 'order.service.ts']);
    assert.equal(resAlpha.completeness.status, 'ready');
    assert.equal(resAlpha.completeness.value, 1.0);

    // 4. Project isolation: proj-alpha query NEVER leaks proj-beta's billing.ts
    assert.ok(!resAlpha.files.some(f => f.name === 'billing.ts'));
});
