import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
} from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('SCN-ARCH-11 (AC-ARCH-04-01 & INV-GR-01): Q3 detects real SCC cycle between modules on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q3-real';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'm_a', 'module', 'ModuleA', 'src/a/a.module.ts'),
            ('${project}', 'b1', 'm_b', 'module', 'ModuleB', 'src/b/b.module.ts'),
            ('${project}', 'b1', 'm_c', 'module', 'ModuleC', 'src/c/c.module.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e_ab', 'm_a', 'm_b', 'depends_on', false),
            ('${project}', 'b1', 'e_bc', 'm_b', 'm_c', 'depends_on', false),
            ('${project}', 'b1', 'e_ca', 'm_c', 'm_a', 'depends_on', false)`);

        const res = await queryCircularDependencies(db, {
            project,
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.project, project);
        assert.equal(res.hasCycles, true);
        assert.equal(res.cycles.length, 1);
        assert.equal(res.cycles[0].length, 3);
        assert.ok(res.cycles[0].includes('ModuleA'));
        assert.ok(res.cycles[0].includes('ModuleB'));
        assert.ok(res.cycles[0].includes('ModuleC'));
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-12 (AC-ARCH-04-02): Shared dependency diamond does NOT produce false positive cycles', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q3-diamond';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'm_top_a', 'module', 'TopA', 'src/top_a.ts'),
            ('${project}', 'b1', 'm_top_b', 'module', 'TopB', 'src/top_b.ts'),
            ('${project}', 'b1', 'm_shared', 'module', 'SharedLib', 'src/shared.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e1', 'm_top_a', 'm_shared', 'depends_on', false),
            ('${project}', 'b1', 'e2', 'm_top_b', 'm_shared', 'depends_on', false)`);

        const res = await queryCircularDependencies(db, {
            project,
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.hasCycles, false);
        assert.deepEqual(res.cycles, []);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-13 (AC-ARCH-04-03 & BR-05): Completeness < 0.70 returns unknown and LOW_COVERAGE, never claims clean', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q3-low';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'm_u1', 'module', 'ModU1', 'src/u1.ts'),
            ('${project}', 'b1', 'm_u2', 'module', 'ModU2', 'src/u2.ts')`);
        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e_u12', 'm_u1', 'm_u2', 'depends_on', false)`);

        const resLow = await queryCircularDependencies(db, {
            project,
            completeness: 0.65,
        });

        assert.equal(resLow.status, 'unknown');
        assert.notEqual(resLow.status, 'ready', 'BR-05: Low coverage graph must NOT claim clean/ready');
        assert.equal(resLow.error, 'LOW_COVERAGE');
        assert.equal(resLow.coverage, 0.65);
        assert.equal(resLow.hasCycles, false);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-26 (AC-ARCH-04-04 & ED1): Graph with 0 depends_on edges explicitly states no cycles with coverage', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q3-zero-edges';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'm_single', 'module', 'SolitaryModule', 'src/single.ts')`);

        const res = await queryCircularDependencies(db, {
            project,
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.hasCycles, false);
        assert.deepEqual(res.cycles, []);
        assert.ok(res.message.includes('không có vòng'), 'Response must explicitly state no cycles');
        assert.equal(res.coverage, 1.0);
        assert.equal(res.totalEdgesChecked, 0);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-27 (AC-ARCH-04-05 & ED10): Prunes dangling edge to deleted module and records DANGLING_MODULE', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q3-dangling';

    try {
        await db.run('ALTER TABLE graph_edge DROP CONSTRAINT IF EXISTS graph_edge_to_node_fk');
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'm_act', 'module', 'LivingModule', 'src/living.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e_dang_mod', 'm_act', 'ObsoleteModule', 'depends_on', false)`);

        const res = await queryCircularDependencies(db, {
            project,
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.equal(res.hasCycles, false);
        assert.deepEqual(res.cycles, []);
        assert.equal(res.unknowns.length, 1);
        assert.equal(res.unknowns[0].type, 'DANGLING_MODULE');
        assert.equal(res.unknowns[0].targetModule, 'ObsoleteModule');
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-28 (INV-GR-03): Multi-project boundary isolation strictly partitions circular dependency queries', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        // Tenant A: Cycle between ModA1 and ModA2
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('tenant-a', 'b1', 'mA1', 'module', 'ModA1', 'src/a1.ts'),
            ('tenant-a', 'b1', 'mA2', 'module', 'ModA2', 'src/a2.ts')`);
        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('tenant-a', 'b1', 'eA1', 'mA1', 'mA2', 'depends_on', false),
            ('tenant-a', 'b1', 'eA2', 'mA2', 'mA1', 'depends_on', false)`);

        // Tenant B: Acyclic
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('tenant-b', 'b1', 'mB1', 'module', 'ModB1', 'src/b1.ts'),
            ('tenant-b', 'b1', 'mB2', 'module', 'ModB2', 'src/b2.ts')`);
        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('tenant-b', 'b1', 'eB1', 'mB1', 'mB2', 'depends_on', false)`);

        const resB = await queryCircularDependencies(db, {
            project: 'tenant-b',
            completeness: 1.0,
        });

        assert.equal(resB.project, 'tenant-b');
        assert.equal(resB.hasCycles, false);
        assert.deepEqual(resB.cycles, []);
    } finally {
        await pg.cleanup();
    }
});
