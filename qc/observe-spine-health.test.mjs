import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createObserveApp, bootObserveDb } from '@mu/harness-observe-server';

function tempTenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-spine-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'qc-spine', displayName: 'QC' },
            server: { host: '127.0.0.1', port: 0 },
            storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        }),
    );
    return {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'qc-spine', displayName: 'QC' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8801 },
        ingest: {
            pollMs: 2000,
            transcriptDir: path.join(root, 'missing-transcripts'),
            hookFiles: [],
        },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
}

test('GET /health reports degraded ingest spine when transcript dir missing', async () => {
    const cfg = tempTenant();
    bootObserveDb(cfg);
    const prev = process.env.HARNESS_CURSOR_MOUNT;
    process.env.HARNESS_CURSOR_MOUNT = '/host-cursor';
    const app = createObserveApp(cfg, { pollIngest: false });
    app.setPort(8801);
    try {
        const res = await app.handler(new Request('http://127.0.0.1/health'));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.degraded, true);
        assert.ok(Array.isArray(body.ingestSpine?.warnings));
        assert.equal(body.ingestSpine?.spineOk, false);
        assert.equal(body.ingestSpine?.transcriptDirExists, false);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_CURSOR_MOUNT;
        else process.env.HARNESS_CURSOR_MOUNT = prev;
    }
});
