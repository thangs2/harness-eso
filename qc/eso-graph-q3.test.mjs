import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initSchema,
    queryCircularDependencies,
    DEFAULT_THRESHOLD_Q3,
    DEFAULT_FLOOR_Q3,
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

test('SCN-ARCH-11 (AC-ARCH-04-01 & INV-GR-01): Q3 detects real SCC cycle between modules', () => {
    const db = createDb();
    const project = 'proj-q3-real';

    // 3 modules in a 3-way cycle: ModA -> ModB -> ModC -> ModA
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('m_a', '${project}', 'module', 'ModuleA', 'src/a/a.module.ts', '2026-11-03', '2026-11-03'),
        ('m_b', '${project}', 'module', 'ModuleB', 'src/b/b.module.ts', '2026-11-03', '2026-11-03'),
        ('m_c', '${project}', 'module', 'ModuleC', 'src/c/c.module.ts', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_ab', '${project}', 'm_a', 'm_b', 'depends_on', '2026-11-03'),
        ('e_bc', '${project}', 'm_b', 'm_c', 'depends_on', '2026-11-03'),
        ('e_ca', '${project}', 'm_c', 'm_a', 'depends_on', '2026-11-03')`);

    const res = queryCircularDependencies(db, {
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
});

test('SCN-ARCH-12 (AC-ARCH-04-02): Shared dependency diamond does NOT produce false positive cycles', () => {
    const db = createDb();
    const project = 'proj-q3-diamond';

    // ModA -> SharedLib, ModB -> SharedLib (Acyclic DAG)
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('m_top_a', '${project}', 'module', 'TopA', 'src/top_a.ts', '2026-11-03', '2026-11-03'),
        ('m_top_b', '${project}', 'module', 'TopB', 'src/top_b.ts', '2026-11-03', '2026-11-03'),
        ('m_shared', '${project}', 'module', 'SharedLib', 'src/shared.ts', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e1', '${project}', 'm_top_a', 'm_shared', 'depends_on', '2026-11-03'),
        ('e2', '${project}', 'm_top_b', 'm_shared', 'depends_on', '2026-11-03')`);

    const res = queryCircularDependencies(db, {
        project,
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.hasCycles, false);
    assert.deepEqual(res.cycles, []);
});

test('SCN-ARCH-13 (AC-ARCH-04-03 & BR-05): Completeness < 0.70 returns unknown and LOW_COVERAGE, never claims clean', () => {
    const db = createDb();
    const project = 'proj-q3-low';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('m_u1', '${project}', 'module', 'ModU1', 'src/u1.ts', '2026-11-03', '2026-11-03'),
        ('m_u2', '${project}', 'module', 'ModU2', 'src/u2.ts', '2026-11-03', '2026-11-03')`);
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_u12', '${project}', 'm_u1', 'm_u2', 'depends_on', '2026-11-03')`);

    // completeness = 0.65 (< floor 0.70)
    const resLow = queryCircularDependencies(db, {
        project,
        completeness: 0.65,
    });

    assert.equal(resLow.status, 'unknown');
    assert.notEqual(resLow.status, 'ready', 'BR-05: Low coverage graph must NOT claim clean/ready');
    assert.equal(resLow.error, 'LOW_COVERAGE');
    assert.equal(resLow.coverage, 0.65);
    assert.equal(resLow.hasCycles, false);
});

test('SCN-ARCH-26 (AC-ARCH-04-04 & ED1): Graph with 0 depends_on edges explicitly states no cycles with coverage', () => {
    const db = createDb();
    const project = 'proj-q3-zero-edges';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('m_single', '${project}', 'module', 'SolitaryModule', 'src/single.ts', '2026-11-03', '2026-11-03')`);

    const res = queryCircularDependencies(db, {
        project,
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.hasCycles, false);
    assert.deepEqual(res.cycles, []);
    assert.ok(res.message.includes('không có vòng'), 'Response must explicitly state no cycles');
    assert.equal(res.coverage, 1.0);
    assert.equal(res.totalEdgesChecked, 0);
});

test('SCN-ARCH-27 (AC-ARCH-04-05 & ED10): Prunes dangling edge to deleted module and records DANGLING_MODULE', () => {
    const db = createDb();
    const project = 'proj-q3-dangling';

    // Active module points to a deleted module
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
        ('m_act', '${project}', 'module', 'LivingModule', 'src/living.ts', '{}', '2026-11-03', '2026-11-03'),
        ('m_del', '${project}', 'module', 'ObsoleteModule', 'src/obsolete.ts', '{"deleted":true}', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_dang_mod', '${project}', 'm_act', 'm_del', 'depends_on', '2026-11-03')`);

    const res = queryCircularDependencies(db, {
        project,
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.hasCycles, false);
    assert.deepEqual(res.cycles, []);
    assert.equal(res.unknowns.length, 1);
    assert.equal(res.unknowns[0].type, 'DANGLING_MODULE');
    assert.equal(res.unknowns[0].targetModule, 'ObsoleteModule');
});

test('SCN-ARCH-28 (INV-GR-03): Multi-project boundary isolation strictly partitions circular dependency queries', () => {
    const db = createDb();

    // Tenant A: Cycle between ModA1 and ModA2
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('mA1', 'tenant-a', 'module', 'ModA1', 'src/a1.ts', '2026-11-03', '2026-11-03'),
        ('mA2', 'tenant-a', 'module', 'ModA2', 'src/a2.ts', '2026-11-03', '2026-11-03')`);
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('eA1', 'tenant-a', 'mA1', 'mA2', 'depends_on', '2026-11-03'),
        ('eA2', 'tenant-a', 'mA2', 'mA1', 'depends_on', '2026-11-03')`);

    // Tenant B: Acyclic
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('mB1', 'tenant-b', 'module', 'ModB1', 'src/b1.ts', '2026-11-03', '2026-11-03'),
        ('mB2', 'tenant-b', 'module', 'ModB2', 'src/b2.ts', '2026-11-03', '2026-11-03')`);
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('eB1', 'tenant-b', 'mB1', 'mB2', 'depends_on', '2026-11-03')`);

    const resB = queryCircularDependencies(db, {
        project: 'tenant-b',
        completeness: 1.0,
    });

    assert.equal(resB.project, 'tenant-b');
    assert.equal(resB.hasCycles, false);
    assert.deepEqual(resB.cycles, []);
});
