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

test('manifest_entry: PK, append-only trigger, and RLS tenant isolation', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const appRole = `app_role_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
        // 1. Insert manifest entries for two projects
        await db.run(
            `INSERT INTO manifest_entry (project, build_id, kind, logical_id, path)
             VALUES ('proj-alpha', 'b1', 'file', 'src/app.cs', 'src/app.cs')`
        );
        await db.run(
            `INSERT INTO manifest_entry (project, build_id, kind, logical_id, path)
             VALUES ('proj-beta', 'b1', 'file', 'src/secret.cs', 'src/secret.cs')`
        );

        // Duplicate PK should fail
        await assert.rejects(async () => {
            await db.run(
                `INSERT INTO manifest_entry (project, build_id, kind, logical_id, path)
                 VALUES ('proj-alpha', 'b1', 'file', 'src/app.cs', 'duplicate/path.cs')`
            );
        }, /duplicate key value violates unique constraint|unique constraint/i);

        // 2. Append-only enforcement: UPDATE must fail via trigger
        await assert.rejects(async () => {
            await db.run(
                `UPDATE manifest_entry SET path = 'modified.cs' WHERE project = 'proj-alpha' AND logical_id = 'src/app.cs'`
            );
        }, /append-only/i);

        // 3. Append-only enforcement: DELETE must fail via trigger
        await assert.rejects(async () => {
            await db.run(
                `DELETE FROM manifest_entry WHERE project = 'proj-alpha' AND logical_id = 'src/app.cs'`
            );
        }, /append-only/i);

        // 4. RLS isolation using non-superuser role
        await db.exec(`
            CREATE ROLE ${appRole} NOLOGIN;
            GRANT USAGE ON SCHEMA ${pg.schema} TO ${appRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${pg.schema} TO ${appRole};
            SET ROLE ${appRole};
            SET eso.project = 'proj-alpha';
        `);

        const visibleEntries = await db.all(`SELECT * FROM manifest_entry`);
        assert.equal(visibleEntries.length, 1);
        assert.equal(visibleEntries[0].logical_id, 'src/app.cs');
        assert.equal(visibleEntries[0].project, 'proj-alpha');

        await db.exec(`RESET ROLE;`);
        await db.exec(`RESET eso.project;`);
    } finally {
        try {
            await db.exec(`RESET ROLE;`);
            await db.exec(`DROP OWNED BY ${appRole};`);
            await db.exec(`DROP ROLE IF EXISTS ${appRole};`);
        } catch {}
        await pg.cleanup();
    }
});

test('graph_index_run: PK, status transitions, immutable keys trigger, and RLS', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const appRole = `app_role_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
        // 1. Insert graph_index_run
        await db.run(
            `INSERT INTO graph_index_run (project, build_id, source_kind, source_hash, status)
             VALUES ('proj-alpha', 'b1', 'roslyn', 'hash-123', 'queued')`
        );
        await db.run(
            `INSERT INTO graph_index_run (project, build_id, source_kind, source_hash, status)
             VALUES ('proj-beta', 'b1', 'roslyn', 'hash-999', 'queued')`
        );

        // Check constraint on status
        await assert.rejects(async () => {
            await db.run(
                `INSERT INTO graph_index_run (project, build_id, source_kind, source_hash, status)
                 VALUES ('proj-alpha', 'b2', 'roslyn', 'hash-456', 'invalid_status')`
            );
        }, /violates check constraint/i);

        // 2. Valid status transition: queued -> running -> succeeded
        await db.run(
            `UPDATE graph_index_run SET status = 'running' WHERE project = 'proj-alpha' AND build_id = 'b1' AND source_kind = 'roslyn'`
        );
        let row = (await db.all(`SELECT status FROM graph_index_run WHERE project = 'proj-alpha'`))[0];
        assert.equal(row.status, 'running');

        await db.run(
            `UPDATE graph_index_run SET status = 'succeeded', completed_at = now() WHERE project = 'proj-alpha' AND build_id = 'b1' AND source_kind = 'roslyn'`
        );
        row = (await db.all(`SELECT status, completed_at FROM graph_index_run WHERE project = 'proj-alpha'`))[0];
        assert.equal(row.status, 'succeeded');
        assert.ok(row.completed_at);

        // 3. Immutable columns cannot be changed: trigger check_graph_index_run_immutable_keys
        await assert.rejects(async () => {
            await db.run(
                `UPDATE graph_index_run SET source_hash = 'different-hash' WHERE project = 'proj-alpha' AND build_id = 'b1' AND source_kind = 'roslyn'`
            );
        }, /IMMUTABLE_KEY|cannot be modified/i);

        await assert.rejects(async () => {
            await db.run(
                `UPDATE graph_index_run SET project = 'other-project' WHERE project = 'proj-alpha' AND build_id = 'b1' AND source_kind = 'roslyn'`
            );
        }, /IMMUTABLE_KEY|cannot be modified/i);

        // 4. RLS isolation using non-superuser role
        await db.exec(`
            CREATE ROLE ${appRole} NOLOGIN;
            GRANT USAGE ON SCHEMA ${pg.schema} TO ${appRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${pg.schema} TO ${appRole};
            SET ROLE ${appRole};
            SET eso.project = 'proj-alpha';
        `);

        const visibleRuns = await db.all(`SELECT * FROM graph_index_run`);
        assert.equal(visibleRuns.length, 1);
        assert.equal(visibleRuns[0].project, 'proj-alpha');
        assert.equal(visibleRuns[0].source_hash, 'hash-123');

        await db.exec(`RESET ROLE;`);
        await db.exec(`RESET eso.project;`);
    } finally {
        try {
            await db.exec(`RESET ROLE;`);
            await db.exec(`DROP OWNED BY ${appRole};`);
            await db.exec(`DROP ROLE IF EXISTS ${appRole};`);
        } catch {}
        await pg.cleanup();
    }
});
