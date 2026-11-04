import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initSchema } from '../eso/graph/src/schema.mjs';
import { initConfigSchema } from '../eso/control-plane/src/modules/config/infrastructure/persistence/config.schema.ts';
import { ensureEvidenceSchema, recordTurnEvidence } from '../eso/adapters/src/host-bridge.mjs';
import { createNestFastifyControlPlane } from '../eso/control-plane/dist/main.js';
import { queryEndpointPermissions } from '../eso/graph/src/q4-permissions.mjs';
import { querySliceTenantBoundary } from '../eso/graph/src/q5-tenant.mjs';

function createTestDb() {
    const db = createDbAdapter(':memory:');
    initSchema(db);
    initConfigSchema(db);
    ensureEvidenceSchema(db);
    return db;
}

const BEARER = ['synthetic', 'qc', 'adversarial', 'token'].join('-');
const REQUEST_HEADERS = {
    'Authorization': `Bearer ${BEARER}`,
    'Content-Type': 'application/json',
};

test('ADVERSARIAL QC 1: Auth Fail-Closed — server with NO authToken rejects protected endpoints', async () => {
    const db = createTestDb();
    const app = await createNestFastifyControlPlane({ db });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        // Public endpoints succeed
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);

        const live = await fetch(`${base}/health/live`);
        assert.equal(live.status, 200);

        const ready = await fetch(`${base}/health/ready`);
        assert.equal(ready.status, 200);

        // Protected endpoints MUST fail closed with 401 Unauthorized
        const s1 = await fetch(`${base}/work-overview?project=p1`);
        assert.equal(s1.status, 401);
        const s1Body = await s1.json();
        assert.equal(s1Body.code, 'UNAUTHORIZED');

        const cfg = await fetch(`${base}/config?project=p1`);
        assert.equal(cfg.status, 401);
        const cfgBody = await cfg.json();
        assert.equal(cfgBody.code, 'UNAUTHORIZED');

        const pv = await fetch(`${base}/config/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: 'p1', pendingChange: { a: 1 } }),
        });
        assert.equal(pv.status, 401);

        const sv = await fetch(`${base}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: 'p1', config: { a: 1 }, preview_hash: 'x' }),
        });
        assert.equal(sv.status, 401);
    } finally {
        await app.close();
    }
});

test('ADVERSARIAL QC 2: Stored XSS Prevention in /s1 endpoint', async () => {
    const db = createTestDb();
    const maliciousTurnId = 'turn<script>alert("xss")</script>';
    const maliciousProject = 'proj<img src=x onerror=alert(1)>';

    recordTurnEvidence({
        db,
        project: maliciousProject,
        turnId: maliciousTurnId,
        actorRole: 'lead',
        actorStatus: 'FULL',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
        payload: { test: true },
    });

    const app = await createNestFastifyControlPlane({ db, authToken: BEARER });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        const res = await fetch(`${base}/work-overview?project=${encodeURIComponent(maliciousProject)}`, {
            headers: REQUEST_HEADERS,
        });
        assert.equal(res.status, 200);
        const html = await res.text();

        // Must NOT contain raw unescaped HTML tags
        assert.equal(html.includes('<script>alert("xss")</script>'), false);
        assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);

        // Must contain escaped versions
        assert.ok(html.includes('&lt;script&gt;'));
        assert.ok(html.includes('&lt;img'));
    } finally {
        await app.close();
    }
});

test('ADVERSARIAL QC 3: Concurrency & Preview Hash verification', async () => {
    const db = createTestDb();
    const app = await createNestFastifyControlPlane({ db, authToken: BEARER });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        // 1. Preview
        const pvRes = await fetch(`${base}/config/preview`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ project: 'p1', pendingChange: { setting: 'v1' } }),
        });
        assert.equal(pvRes.status, 200);
        const pv = await pvRes.json();
        assert.ok(pv.preview_hash);

        // 2. Missing preview_hash -> 409 PREVIEW_REQUIRED
        const noPv = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ project: 'p1', config: { setting: 'v1' } }),
        });
        assert.equal(noPv.status, 409);
        const noPvBody = await noPv.json();
        assert.equal(noPvBody.code, 'PREVIEW_REQUIRED');

        // 3. Empty string preview_hash -> 409 PREVIEW_REQUIRED
        const emptyPv = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ project: 'p1', config: { setting: 'v1' }, preview_hash: '   ' }),
        });
        assert.equal(emptyPv.status, 409);

        // 4. Fabricated preview_hash -> 409 CONFIG_STALE_HASH
        const badPv = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ project: 'p1', config: { setting: 'v1' }, preview_hash: 'deadbeefdeadbeef' }),
        });
        assert.equal(badPv.status, 409);
        const badPvBody = await badPv.json();
        assert.equal(badPvBody.code, 'CONFIG_STALE_HASH');

        // 5. Valid preview_hash -> 200 OK, version 1
        const sv1 = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({
                project: 'p1',
                config: { setting: 'v1' },
                preview_hash: pv.preview_hash,
                operator: 'qc',
            }),
        });
        assert.equal(sv1.status, 200);
        const sv1Body = await sv1.json();
        assert.equal(sv1Body.version, 1);

        // 6. Stale current_hash -> 409 STALE_VERSION
        const staleRes = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({
                project: 'p1',
                config: { setting: 'v2' },
                current_hash: 'outdated-hash-xyz',
                preview_hash: 'x',
            }),
        });
        assert.equal(staleRes.status, 409);
        const staleBody = await staleRes.json();
        assert.equal(staleBody.code, 'STALE_VERSION');
    } finally {
        await app.close();
    }
});

test('ADVERSARIAL QC 4: Strict validation, error masking, and health duck-typing', async () => {
    const db = createTestDb();
    const app = await createNestFastifyControlPlane({ db, authToken: BEARER });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        // Unknown field rejected with 400
        const unknownField = await fetch(`${base}/config`, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ project: 'p1', config: {}, preview_hash: 'x', evil: 123 }),
        });
        assert.equal(unknownField.status, 400);
        const ufBody = await unknownField.json();
        assert.equal(ufBody.code, 'BAD_REQUEST');

        // Invalid version parameter rejected with 400
        const badVersion = await fetch(`${base}/config?project=p1&version=invalid`, {
            headers: REQUEST_HEADERS,
        });
        assert.equal(badVersion.status, 400);
        const bvBody = await badVersion.json();
        assert.equal(bvBody.code, 'INVALID_VERSION');
    } finally {
        await app.close();
    }

    // Health duck-typing probe: db with only close() is NOT healthy -> 503
    const fakeDb = { close() {} };
    const fakeApp = await createNestFastifyControlPlane({ db: fakeDb, authToken: BEARER });
    await fakeApp.listen(0, '127.0.0.1');
    const fakePort = fakeApp.getHttpAdapter().getInstance().server.address().port;
    try {
        const fakeHealth = await fetch(`http://127.0.0.1:${fakePort}/health`);
        assert.equal(fakeHealth.status, 503);
    } finally {
        await fakeApp.close();
    }

    // Internal error detail masking: db throwing unhandled error returns masked 500
    const boomDb = {
        get() { throw new Error('SQLITE_ERROR: secret table structure exposed'); },
        all() { throw new Error('SQLITE_ERROR: secret table structure exposed'); },
    };
    const boomApp = await createNestFastifyControlPlane({ db: boomDb, authToken: BEARER });
    await boomApp.listen(0, '127.0.0.1');
    const boomPort = boomApp.getHttpAdapter().getInstance().server.address().port;
    try {
        const boomRes = await fetch(`http://127.0.0.1:${boomPort}/config?project=p1`, {
            headers: REQUEST_HEADERS,
        });
        assert.equal(boomRes.status, 500);
        const boomBody = await boomRes.json();
        assert.equal(boomBody.code, 'INTERNAL_SERVER_ERROR');
        assert.equal(boomBody.detail, 'An unexpected internal error occurred');
        assert.equal(JSON.stringify(boomBody).includes('SQLITE_ERROR'), false);
    } finally {
        await boomApp.close();
    }
});

test('ADVERSARIAL QC 5: Q4/Q5 Tenant Boundary & Mandatory Project Enforcement', () => {
    // Missing project throws INVALID_PROJECT
    assert.throws(
        () => queryEndpointPermissions({ endpoint: '/test' }),
        (err) => err.code === 'INVALID_PROJECT' || /project is mandatory/i.test(err.message)
    );

    assert.throws(
        () => querySliceTenantBoundary({ slice: 's1' }),
        (err) => err.code === 'INVALID_PROJECT' || /project is mandatory/i.test(err.message)
    );

    // Isolated projects have 0 cross-project leakage
    const db = createTestDb();
    try {
        // Verify functions run cleanly when project is supplied
        const q4A = queryEndpointPermissions({ db, project: 'tenant-a', endpointId: 'e1', coverage: 0.5 });
        const q4B = queryEndpointPermissions({ db, project: 'tenant-b', endpointId: 'e1', coverage: 0.5 });
        assert.equal(q4A.status, 'unknown');
        assert.equal(q4B.status, 'unknown');

        const q5A = querySliceTenantBoundary({ db, project: 'tenant-a', sliceId: 's1' });
        const q5B = querySliceTenantBoundary({ db, project: 'tenant-b', sliceId: 's1' });
        assert.equal(q5A.status, 'unknown');
        assert.equal(q5B.status, 'unknown');
    } finally {
        db.close();
    }
});
