import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createObserveApp, bootObserveDb } from '@mu/harness-observe-server';
import { runIngestOnce } from '@mu/harness-observe-server';
import { buildLive } from '../packages/harness-observe-server/src/route-watch.mjs';

function tempTenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-observe-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'qc-tenant', displayName: 'QC' },
            server: { host: '127.0.0.1', port: 0 },
            storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        }),
    );
    const cfg = {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'qc-tenant', displayName: 'QC' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8799 },
        ingest: { pollMs: 2000, transcriptDir: '/tmp', hookFiles: [] },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
    return cfg;
}

test('ingest is idempotent (migrate + project row)', async () => {
    const cfg = tempTenant();
    bootObserveDb(cfg);
    const a = await runIngestOnce(cfg, { force: true });
    const b = await runIngestOnce(cfg, { force: true });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(a.counts, b.counts);
    assert.equal(b.migrations.length, 0);
});

test('API contract: version + POST-only ingest/run', async () => {
    const cfg = tempTenant();
    bootObserveDb(cfg);
    const app = createObserveApp(cfg, { pollIngest: false });
    app.setPort(8800);

    const versionRes = await app.handler(new Request('http://127.0.0.1/api/version'));
    assert.equal(versionRes.status, 200);
    const version = await versionRes.json();
    assert.equal(version.apiVersion, '1');
    assert.equal(version.package, '@mu/harness-observe-server');

    const getIngest = await app.handler(new Request('http://127.0.0.1/api/ingest/run'));
    assert.equal(getIngest.status, 405);

    const postIngest = await app.handler(
        new Request('http://127.0.0.1/api/ingest/run', { method: 'POST' }),
    );
    assert.equal(postIngest.status, 200);
    const report = await postIngest.json();
    assert.equal(report.ok, true);
});

test('buildLive runs on empty tenant root', () => {
    const cfg = tempTenant();
    const snap = buildLive({ root: cfg.root, files: [], ruleIndex: { present: false, generatedAt: null } });
    assert.equal(typeof snap.generatedAt, 'string');
    assert.equal(snap.root, cfg.root);
    assert.ok(Array.isArray(snap.turns));
});

test('GET /live.json returns legacy snapshot with revision', async () => {
    const cfg = tempTenant();
    bootObserveDb(cfg);
    const app = createObserveApp(cfg, { pollIngest: false });
    app.setPort(8801);

    const res = await app.handler(new Request('http://127.0.0.1/live.json'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.revision >= 1);
    assert.ok(body.totals);
    assert.ok(Array.isArray(body.turns));
});
