import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb, migrate, upsertProject } from '@mu/harness-observe-server';
import { runFacadeBackfill } from '../packages/harness-observe-server/src/decision-ingest.mjs';
import { runEsoBackfill } from '../packages/harness-observe-server/src/eso-ingest.mjs';

const MIGRATIONS = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../packages/harness-observe-server/db/migrations',
);

function project({ ledgerEnabled = true, prefix = 'facade-backfill' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${prefix}-`));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ project: { id: 'fb-qc' }, storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } } }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            profile: 'generic-eso',
            ledgers: undefined,
            ledger: { enabled: ledgerEnabled },
            eso: { enabled: true, mode: 'observe', sources: { law: { enabled: false }, code: { enabled: false }, memory: { enabled: false } } },
        }),
    );
    const cfg = {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'fb-qc', displayName: 'fb-qc' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8792 },
        ingest: { pollMs: 2000, transcriptDir: '', hookFiles: [] },
        registry: { mode: 'isolated', registry: '' },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
    const db = openDb(dbPath);
    migrate(db);
    upsertProject(db, cfg);
    return { cfg, db, migrationsDir: MIGRATIONS };
}

function seedRequest(db, cfg, id, boundary) {
    db.run(
        `INSERT INTO conversation (id, project_id, started_at, ended_at, request_count, created_at, updated_at)
         VALUES ('conv-1', ?, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z', 1,
                 '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')
         ON CONFLICT(id) DO NOTHING`,
        [cfg.project.id],
    );
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
            started_at, status, generation_id, created_at, updated_at)
         VALUES (?, ?, 'conv-1', ?, 'seed query', 'Mon Oct 12 2026', '2026-10-12T10:00:00Z',
            'completed', ?, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')`,
        [id, cfg.project.id, boundary, id],
    );
}

const facadeRows = (db, id) =>
    db
        .all(
            `SELECT event_type FROM decision_ledger WHERE request_id = ? AND event_type IN ('turn_start','pre_guard_shell')`,
            [id],
        )
        .map((r) => r.event_type);

test('runFacadeBackfill is disabled when the ledger is off', async () => {
    const { cfg, db } = project({ ledgerEnabled: false, prefix: 'facade-off' });
    seedRequest(db, cfg, 'r:1', 1);
    const out = await runFacadeBackfill(db, cfg, { limit: 5 });
    assert.equal(out.disabled, true);
    assert.equal(out.pending, 0);
    assert.deepEqual(facadeRows(db, 'r:1'), []);
    db.close();
});

test('runFacadeBackfill leaves requests that already have a turn_start row', async () => {
    const { cfg, db } = project({ prefix: 'facade-prior' });
    seedRequest(db, cfg, 'r:1', 1);
    db.run(
        `INSERT INTO decision_ledger (id, project_id, conversation_id, request_id, event_type, jev_mode, enforced_verdict, created_at)
         VALUES ('dl-1', ?, 'conv-1', 'r:1', 'turn_start', 'off', 'ok', '2026-10-12T10:00:01Z')`,
        [cfg.project.id],
    );
    const out = await runFacadeBackfill(db, cfg, { limit: 5 });
    assert.equal(out.disabled, false);
    // Nothing to do, and crucially not re-decided: pending already reflects the existing row.
    assert.equal(out.pending, 0);
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM decision_ledger WHERE request_id = 'r:1'`)?.n, 1);
    db.close();
});

test('runFacadeBackfill reports pending so a caller can see convergence', async () => {
    const { cfg, db } = project({ prefix: 'facade-pending' });
    seedRequest(db, cfg, 'r:1', 1);
    const out = await runFacadeBackfill(db, cfg, { limit: 1 });
    assert.equal(out.disabled, false);
    assert.ok(typeof out.pending === 'number');
    assert.ok(out.pending >= 0);
    db.close();
});

test('a decided request actually gets a turn_start ledger row', async () => {
    // Regression: `decide()` only persists when ctx.writeLedger is true, and the ingest
    // caller did not pass it — so the facade reported work done while writing nothing, and
    // every design graph stayed on the coarse transcript fallback.
    const { cfg, db } = project({ prefix: 'facade-writes' });
    seedRequest(db, cfg, 'r:1', 1);
    const out = await runFacadeBackfill(db, cfg, { limit: 1 });
    assert.equal(out.disabled, false);
    assert.equal(out.ran, 1);
    const rows = db.all(
        `SELECT event_type, jev_mode, enforced_verdict, project_id, conversation_id FROM decision_ledger WHERE request_id = 'r:1'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'turn_start');
    assert.ok(rows[0].jev_mode);
    assert.ok(rows[0].enforced_verdict);
    // project_id must be set: readers scope by it, and the schema permits NULL, so omitting
    // it produced a row that existed in the table but was invisible to every query.
    assert.equal(rows[0].project_id, cfg.project.id);
    assert.equal(rows[0].conversation_id, 'conv-1');
    // The project-scoped read the detail page uses must actually return it.
    const scoped = db.all(
        `SELECT id FROM decision_ledger WHERE project_id = ? AND request_id = 'r:1' AND event_type != 'evidence_sufficiency'`,
        [cfg.project.id],
    );
    assert.equal(scoped.length, 1);
    // Backfill is idempotent: a second pass must not duplicate the row.
    const again = await runFacadeBackfill(db, cfg, { limit: 1 });
    assert.equal(again.ran, 0);
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM decision_ledger WHERE request_id = 'r:1'`)?.n, 1);
    db.close();
});

test('runEsoBackfill is disabled when eso.enabled is false', async () => {
    const { cfg, db } = project({ prefix: 'eso-off' });
    fs.writeFileSync(
        cfg.decisionPolicyPath,
        JSON.stringify({ version: 1, ledger: { enabled: true }, eso: { enabled: false } }),
    );
    seedRequest(db, cfg, 'r:1', 1);
    const out = await runEsoBackfill(db, cfg, { limit: 5 });
    assert.equal(out.disabled, true);
    db.close();
});
