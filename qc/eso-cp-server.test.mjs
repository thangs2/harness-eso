import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initConfigSchema } from '../eso/control-plane/src/config-schema.mjs';
import { saveConfig } from '../eso/control-plane/src/config-store.mjs';
import { createControlPlaneServer } from '../eso/control-plane/src/server.mjs';

const AUTH_TOKEN = 'test-bearer-token';
let db;
let server;
let baseUrl;

before(async () => {
    db = createDbAdapter(':memory:');
    initConfigSchema(db);

    server = createControlPlaneServer({ db, authToken: AUTH_TOKEN });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
});

after(() => {
    if (server) server.close();
});

test('ESO-370: GET /health returns 200 without token', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'eso-control-plane');
});

test('ESO-370: protected endpoints return 401 when token is missing or invalid', async () => {
    // Missing token
    const resNoToken = await fetch(`${baseUrl}/config?project=p1`);
    assert.equal(resNoToken.status, 401);
    const bodyNoToken = await resNoToken.json();
    assert.equal(bodyNoToken.error, 'UNAUTHORIZED');

    // Invalid token
    const resBadToken = await fetch(`${baseUrl}/config?project=p1`, {
        headers: { Authorization: 'Bearer bad-token' },
    });
    assert.equal(resBadToken.status, 401);
});

test('ESO-370: GET /config reads from store with valid token', async () => {
    const project = 'proj-cp-test';
    const saved = saveConfig(db, {
        project,
        config: { setting: 'val-101', mode: 'strict' },
        operator: 'alice',
    });

    const res = await fetch(`${baseUrl}/config?project=${project}`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.project, project);
    assert.equal(body.version, saved.version);
    assert.equal(body.hash, saved.hash);
    assert.equal(body.config.setting, 'val-101');
});

test('ESO-370: POST /config without preview hash returns 409 PREVIEW_REQUIRED', async () => {
    const project = 'proj-no-preview';

    const res = await fetch(`${baseUrl}/config`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            project,
            config: { something: 'new' },
            // preview_hash omitted!
        }),
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'PREVIEW_REQUIRED');
    assert.ok(body.message.includes('preview hash'));
});

test('ESO-370: preview -> save with current_hash succeeds (version +1), stale hash returns 409', async () => {
    const project = 'proj-preview-save-flow';

    // 1. Initial save
    const initial = saveConfig(db, {
        project,
        config: { version: 1, setting: 'init' },
        operator: 'alice',
    });

    // 2. Request preview
    const prevRes = await fetch(`${baseUrl}/config/preview`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            project,
            pendingChange: { setting: 'updated' },
        }),
    });
    assert.equal(prevRes.status, 200);
    const prevBody = await prevRes.json();
    assert.ok(prevBody.preview_hash);
    assert.equal(prevBody.current_hash, initial.hash);

    // 3. Save with matching current_hash and preview_hash -> 200, version + 1
    const saveRes = await fetch(`${baseUrl}/config`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            project,
            config: { setting: 'updated' },
            current_hash: prevBody.current_hash,
            preview_hash: prevBody.preview_hash,
            operator: 'alice',
        }),
    });
    assert.equal(saveRes.status, 200);
    const saveBody = await saveRes.json();
    assert.equal(saveBody.ok, true);
    assert.equal(saveBody.version, initial.version + 1);

    // 4. Save with old/stale current_hash -> 409 STALE_VERSION
    const staleRes = await fetch(`${baseUrl}/config`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            project,
            config: { setting: 'attempt-stale' },
            current_hash: initial.hash, // stale!
            preview_hash: 'dummy_preview',
            operator: 'alice',
        }),
    });
    assert.equal(staleRes.status, 409);
    const staleBody = await staleRes.json();
    assert.equal(staleBody.error, 'STALE_VERSION');
});

test('ESO-370: GET /health returns 503 when store is broken', async () => {
    // Create server with broken DB
    const brokenDb = {
        get() { throw new Error('DB connection failed'); },
    };
    const brokenServer = createControlPlaneServer({ db: brokenDb });
    await new Promise((resolve) => {
        brokenServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = brokenServer.address();
    try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'unhealthy');
        assert.equal(body.error, 'STORE_UNAVAILABLE');
    } finally {
        brokenServer.close();
    }
});
