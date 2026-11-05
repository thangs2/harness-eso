import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    queryColumnImpact,
    DEFAULT_THRESHOLD_Q2,
    DEFAULT_FLOOR_Q2,
} from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('SCN-ARCH-08 (AC-ARCH-03-01 & INV-GR-01): Q2 returns reverse-dependency impact chain entity -> dto -> app_service on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q2-chain';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_tbl_invoice', 'table', 'invoices', 'db/schema/invoices.sql'),
            ('${project}', 'b1', 'n_ent_invoice', 'entity', 'InvoiceEntity', 'src/entities/invoice.entity.ts'),
            ('${project}', 'b1', 'n_dto_invoice', 'dto', 'InvoiceDto', 'src/dtos/invoice.dto.ts'),
            ('${project}', 'b1', 'n_svc_invoice', 'app_service', 'InvoiceService', 'src/services/invoice.service.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e1', 'n_ent_invoice', 'n_tbl_invoice', 'maps_to', false),
            ('${project}', 'b1', 'e2', 'n_dto_invoice', 'n_ent_invoice', 'references', false),
            ('${project}', 'b1', 'e3', 'n_svc_invoice', 'n_dto_invoice', 'references', false)`);

        const res = await queryColumnImpact(db, {
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
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-09 (AC-ARCH-03-02 & BR-05): Incomplete coverage yields unknown + LOW_COVERAGE, never "không gãy gì"', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q2-low';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_tbl_accounts', 'table', 'accounts', 'db/accounts.sql'),
            ('${project}', 'b1', 'n_ent_account', 'entity', 'AccountEntity', 'src/entities/account.entity.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e_acc', 'n_ent_account', 'n_tbl_accounts', 'maps_to', false)`);

        // Case A: completeness = 0.85
        const resUnknown = await queryColumnImpact(db, {
            project,
            table: 'accounts',
            completeness: 0.85,
        });

        assert.equal(resUnknown.status, 'unknown');
        assert.notEqual(resUnknown.status, 'absent', 'BR-05: incomplete coverage must report unknown, NEVER absent');
        assert.equal(resUnknown.error, 'LOW_COVERAGE');
        assert.equal(resUnknown.coverage, 0.85);

        // Case B: completeness = 0.30 (sub-floor, refuses)
        const resRefused = await queryColumnImpact(db, {
            project,
            table: 'accounts',
            completeness: 0.30,
        });

        assert.equal(resRefused.status, 'REFUSED');
        assert.notEqual(resRefused.status, 'ready');
        assert.equal(resRefused.error, 'LOW_COVERAGE');
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-10 (AC-ARCH-03-03): Refuses with OVERREACH when candidates contain files not using the table', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q2-overreach';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_tbl_products', 'table', 'products', 'db/products.sql'),
            ('${project}', 'b1', 'n_ent_product', 'entity', 'ProductEntity', 'src/entities/product.entity.ts')`);

        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('${project}', 'b1', 'e_prod', 'n_ent_product', 'n_tbl_products', 'maps_to', false)`);

        const res = await queryColumnImpact(db, {
            project,
            table: 'products',
            completeness: 1.0,
            candidates: ['src/entities/product.entity.ts', 'src/utils/audit-logger.ts'],
        });

        assert.equal(res.status, 'REFUSED');
        assert.equal(res.error, 'OVERREACH');
        assert.ok(res.invalidFiles.includes('src/utils/audit-logger.ts'));
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-24 (AC-ARCH-03-04): Unread table yields empty impact list with 0 fabricated files', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q2-empty';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_tbl_standalone', 'table', 'standalone_meta', 'db/standalone.sql')`);

        const res = await queryColumnImpact(db, {
            project,
            table: 'standalone_meta',
            completeness: 1.0,
        });

        assert.equal(res.status, 'ready');
        assert.deepEqual(res.impactChain, []);
        assert.deepEqual(res.impactedFiles, []);
        assert.deepEqual(res.unknowns, []);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-25 (AC-ARCH-03-05 & ED10): Entity referencing deleted table records DANGLING_TABLE in unknowns', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const project = 'proj-q2-dangling';

    try {
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('${project}', 'b1', 'n_ent_archived', 'entity', 'ArchivedOrderEntity', 'src/entities/archived.entity.ts')`);

        await db.run(`INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim) VALUES
            ('${project}', 'b1', 'e_archived', 1, 'roslyn', 'ArchivedOrderEntity maps_to "archived_orders"')`);

        const res = await queryColumnImpact(db, {
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
    } finally {
        await pg.cleanup();
    }
});

test('SCN-ARCH-26 (INV-GR-03): Multi-project boundary isolation prevents cross-tenant impact bleeding', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        // Tenant Alpha
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('tenant-alpha', 'b1', 'tbl_alpha', 'table', 'tenants', 'db/alpha/tenants.sql'),
            ('tenant-alpha', 'b1', 'ent_alpha', 'entity', 'TenantAlphaEntity', 'src/alpha/tenant.entity.ts')`);
        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('tenant-alpha', 'b1', 'e_alpha', 'ent_alpha', 'tbl_alpha', 'maps_to', false)`);

        // Tenant Beta
        await db.run(`INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
            ('tenant-beta', 'b1', 'tbl_beta', 'table', 'tenants', 'db/beta/tenants.sql'),
            ('tenant-beta', 'b1', 'ent_beta', 'entity', 'TenantBetaEntity', 'src/beta/tenant.entity.ts')`);
        await db.run(`INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
            ('tenant-beta', 'b1', 'e_beta', 'ent_beta', 'tbl_beta', 'maps_to', false)`);

        const resAlpha = await queryColumnImpact(db, {
            project: 'tenant-alpha',
            table: 'tenants',
            completeness: 1.0,
        });

        assert.equal(resAlpha.project, 'tenant-alpha');
        assert.deepEqual(resAlpha.impactedFiles, ['src/alpha/tenant.entity.ts']);
        assert.ok(!resAlpha.impactedFiles.includes('src/beta/tenant.entity.ts'), 'tenant-beta must NOT bleed into tenant-alpha');
    } finally {
        await pg.cleanup();
    }
});
