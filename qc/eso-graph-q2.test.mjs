import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initSchema,
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
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

test('SCN-ARCH-08 (AC-ARCH-03-01 & INV-GR-01): Q2 returns reverse-dependency impact chain entity -> dto -> app_service', () => {
    const db = createDb();
    const project = 'proj-q2-happy';

    // 1. Populate graph nodes
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_tbl_invoice', '${project}', 'table', 'invoices', 'db/schema/invoices.sql', '2026-11-03', '2026-11-03'),
        ('n_ent_invoice', '${project}', 'entity', 'InvoiceEntity', 'src/entities/invoice.entity.ts', '2026-11-03', '2026-11-03'),
        ('n_dto_invoice', '${project}', 'dto', 'InvoiceDto', 'src/dtos/invoice.dto.ts', '2026-11-03', '2026-11-03'),
        ('n_svc_invoice', '${project}', 'app_service', 'InvoiceService', 'src/services/invoice.service.ts', '2026-11-03', '2026-11-03')`);

    // 2. Populate edges with valid reverse relations
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e1', '${project}', 'n_ent_invoice', 'n_tbl_invoice', 'maps_to', '2026-11-03'),
        ('e2', '${project}', 'n_dto_invoice', 'n_ent_invoice', 'references', '2026-11-03'),
        ('e3', '${project}', 'n_svc_invoice', 'n_dto_invoice', 'references', '2026-11-03')`);

    const res = queryColumnImpact(db, {
        project,
        table: 'invoices',
        column: 'amount',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.project, project);
    assert.equal(res.table, 'invoices');
    assert.equal(res.column, 'amount');
    assert.equal(res.impactChain.length, 3);

    // Assert strict reverse order: entity -> dto -> app_service
    assert.equal(res.impactChain[0].role, 'entity');
    assert.equal(res.impactChain[0].name, 'InvoiceEntity');
    assert.equal(res.impactChain[1].role, 'dto');
    assert.equal(res.impactChain[1].name, 'InvoiceDto');
    assert.equal(res.impactChain[2].role, 'app_service');
    assert.equal(res.impactChain[2].name, 'InvoiceService');

    assert.deepEqual(res.impactedFiles.sort(), [
        'src/dtos/invoice.dto.ts',
        'src/entities/invoice.entity.ts',
        'src/services/invoice.service.ts',
    ].sort());
});

test('SCN-ARCH-09 (AC-ARCH-03-02 & BR-05): Incomplete coverage yields unknown + LOW_COVERAGE, never "không gãy gì"', () => {
    const db = createDb();
    const project = 'proj-q2-low';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_tbl_accounts', '${project}', 'table', 'accounts', 'db/accounts.sql', '2026-11-03', '2026-11-03'),
        ('n_ent_account', '${project}', 'entity', 'AccountEntity', 'src/entities/account.entity.ts', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_acc', '${project}', 'n_ent_account', 'n_tbl_accounts', 'maps_to', '2026-11-03')`);

    // Case A: completeness = 0.85 (below default threshold 0.90, >= floor 0.80)
    const resUnknown = queryColumnImpact(db, {
        project,
        table: 'accounts',
        completeness: 0.85,
    });

    assert.equal(resUnknown.status, 'unknown');
    assert.notEqual(resUnknown.status, 'absent', 'BR-05: incomplete coverage must report unknown, NEVER absent');
    assert.equal(resUnknown.error, 'LOW_COVERAGE');
    assert.equal(resUnknown.coverage, 0.85);

    // Case B: completeness = 0.30 (sub-floor, refuses)
    const resRefused = queryColumnImpact(db, {
        project,
        table: 'accounts',
        completeness: 0.30,
    });

    assert.equal(resRefused.status, 'REFUSED');
    assert.notEqual(resRefused.status, 'ready');
    assert.equal(resRefused.error, 'LOW_COVERAGE');
});

test('SCN-ARCH-10 (AC-ARCH-03-03): Refuses with OVERREACH when candidates contain files not using the table', () => {
    const db = createDb();
    const project = 'proj-q2-overreach';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_tbl_products', '${project}', 'table', 'products', 'db/products.sql', '2026-11-03', '2026-11-03'),
        ('n_ent_product', '${project}', 'entity', 'ProductEntity', 'src/entities/product.entity.ts', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_prod', '${project}', 'n_ent_product', 'n_tbl_products', 'maps_to', '2026-11-03')`);

    // Candidate list includes an unrelated audit logger file
    const res = queryColumnImpact(db, {
        project,
        table: 'products',
        completeness: 1.0,
        candidates: ['src/entities/product.entity.ts', 'src/utils/audit-logger.ts'],
    });

    assert.equal(res.status, 'REFUSED');
    assert.equal(res.error, 'OVERREACH');
    assert.ok(res.invalidFiles.includes('src/utils/audit-logger.ts'));
});

test('SCN-ARCH-24 (AC-ARCH-03-04): Unread table yields empty impact list with 0 fabricated files', () => {
    const db = createDb();
    const project = 'proj-q2-empty';

    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('n_tbl_standalone', '${project}', 'table', 'standalone_meta', 'db/standalone.sql', '2026-11-03', '2026-11-03')`);

    const res = queryColumnImpact(db, {
        project,
        table: 'standalone_meta',
        completeness: 1.0,
    });

    assert.equal(res.status, 'ready');
    assert.deepEqual(res.impactChain, []);
    assert.deepEqual(res.impactedFiles, []);
    assert.deepEqual(res.unknowns, []);
});

test('SCN-ARCH-25 (AC-ARCH-03-05 & ED10): Entity referencing deleted table records DANGLING_TABLE in unknowns', () => {
    const db = createDb();
    const project = 'proj-q2-dangling';

    // Deleted table 'archived_orders' not in graph_node, but entity claims mapping to it
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, metadata_json, created_at, updated_at) VALUES
        ('n_ent_archived', '${project}', 'entity', 'ArchivedOrderEntity', 'src/entities/archived.entity.ts', '{"tableName":"archived_orders"}', '2026-11-03', '2026-11-03')`);

    db.run(`INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at) VALUES
        ('c_archived', '${project}', 'n_ent_archived', 'maps_to', '{"targetTable":"archived_orders"}', '2026-11-03')`);

    const res = queryColumnImpact(db, {
        project,
        table: 'archived_orders',
        completeness: 1.0,
    });

    assert.equal(res.status, 'unknown');
    assert.notEqual(res.status, 'absent', 'BR-05: never say absent / không gãy gì');
    assert.equal(res.error, 'DANGLING_TABLE');
    assert.equal(res.unknowns.length, 1);
    assert.equal(res.unknowns[0].type, 'DANGLING_TABLE');
    assert.equal(res.unknowns[0].table, 'archived_orders');
    assert.ok(res.unknowns[0].referencingEntities.includes('ArchivedOrderEntity'));
});

test('SCN-ARCH-26 (INV-GR-03): Multi-project boundary isolation prevents cross-tenant impact bleeding', () => {
    const db = createDb();

    // Tenant Alpha
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('tbl_alpha', 'tenant-alpha', 'table', 'tenants', 'db/alpha/tenants.sql', '2026-11-03', '2026-11-03'),
        ('ent_alpha', 'tenant-alpha', 'entity', 'TenantAlphaEntity', 'src/alpha/tenant.entity.ts', '2026-11-03', '2026-11-03')`);
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_alpha', 'tenant-alpha', 'ent_alpha', 'tbl_alpha', 'maps_to', '2026-11-03')`);

    // Tenant Beta
    db.run(`INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at) VALUES
        ('tbl_beta', 'tenant-beta', 'table', 'tenants', 'db/beta/tenants.sql', '2026-11-03', '2026-11-03'),
        ('ent_beta', 'tenant-beta', 'entity', 'TenantBetaEntity', 'src/beta/tenant.entity.ts', '2026-11-03', '2026-11-03')`);
    db.run(`INSERT INTO graph_edge (id, project, source_id, target_id, relation, created_at) VALUES
        ('e_beta', 'tenant-beta', 'ent_beta', 'tbl_beta', 'maps_to', '2026-11-03')`);

    const resAlpha = queryColumnImpact(db, {
        project: 'tenant-alpha',
        table: 'tenants',
        completeness: 1.0,
    });

    assert.equal(resAlpha.project, 'tenant-alpha');
    assert.deepEqual(resAlpha.impactedFiles, ['src/alpha/tenant.entity.ts']);
    assert.ok(!resAlpha.impactedFiles.includes('src/beta/tenant.entity.ts'), 'tenant-beta must NOT bleed into tenant-alpha');
});
