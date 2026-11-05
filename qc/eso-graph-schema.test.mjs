import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSchema, TABLES, queryGraphFiles } from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('SCN-ARCH-01 (AC-ARCH-01-01): Warm graph queries return file list with completeness and project isolation on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        // 1. DDL initialization and idempotency (running twice produces no error)
        await initSchema(db);
        await initSchema(db);

        const tablesInDb = (await db.all(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
            pg.schema
        )).map((t) => t.table_name);

        for (const tbl of TABLES) {
            assert.ok(tablesInDb.includes(tbl), `Table ${tbl} must exist`);
        }

        // 2. Insert test graph nodes for two different projects (target columns 26.graph-schema.md)
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES ('proj-alpha', 'b1', 'node-1', 'module', 'order.service.ts', 'src/order.service.ts')`
        );
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES ('proj-alpha', 'b1', 'node-2', 'module', 'order.controller.ts', 'src/order.controller.ts')`
        );
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES ('proj-beta', 'b1', 'node-3', 'module', 'billing.ts', 'src/billing.ts')`
        );

        // 3. Query files for proj-alpha with 100% warm coverage
        const resAlpha = await queryGraphFiles(db, {
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
    } finally {
        await pg.cleanup();
    }
});
