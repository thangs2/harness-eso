import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from './helpers/test-pg-db.mjs';
import { createNestFastifyControlPlane } from '../eso/control-plane/dist/main.js';
import { initSchema } from '../eso/graph/src/schema.mjs';

import { initConfigSchema } from '../eso/control-plane/src/modules/config/infrastructure/persistence/config.schema.ts';

async function createTestDb() {
    const pg = await createTestPgDb();
    await initSchema(pg.db);
    await initConfigSchema(pg.db);
    return pg;
}

const BEARER_SAMPLE = 'synthetic-bearer-sample';

test('ESO-370 / D-71: NestJS + Fastify + Kysely Control Plane server full suite', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    const app = await createNestFastifyControlPlane({
        db,
        authToken: BEARER_SAMPLE,
        authProject: 'p1',
    });

    await app.listen(0, '127.0.0.1');
    const fastifyInstance = app.getHttpAdapter().getInstance();
    const serverAddr = fastifyInstance.server.address();
    const baseUrl = `http://127.0.0.1:${serverAddr.port}`;

    try {
        // 1. GET /health returns 200 without token
        const healthRes = await fetch(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        const healthBody = await healthRes.json();
        assert.equal(healthBody.status, 'ok');
        assert.equal(healthBody.service, 'eso-control-plane');

        // 2. Protected endpoints return 401 when token missing
        const unauthRes = await fetch(`${baseUrl}/config?project=p1`);
        assert.equal(unauthRes.status, 401);

        // 3. GET /config reads config with valid token
        const { saveConfig } = await import('../eso/control-plane/src/modules/config/infrastructure/persistence/repositories/config.repository.ts');
        const savedInitial = await saveConfig(db, {
            project: 'p1',
            config: { setting: 'initial' },
            operator: 'setup',
        });

        const configRes = await fetch(`${baseUrl}/config?project=p1`, {
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
            },
        });
        assert.equal(configRes.status, 200);
        const configBody = await configRes.json();
        assert.equal(configBody.ok, true);
        assert.equal(configBody.version, 1);
        const initialHash = configBody.hash;

        // 4. POST /config/preview
        const previewRes = await fetch(`${baseUrl}/config/preview`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project: 'p1',
                pendingChange: {
                    setting: 'new-value',
                },
            }),
        });
        assert.equal(previewRes.status, 200);
        const previewBody = await previewRes.json();
        assert.equal(previewBody.ok, true);
        assert.ok(previewBody.preview_hash);
        assert.equal(previewBody.current_hash, initialHash);

        // 5. POST /config without preview hash returns 409 PREVIEW_REQUIRED
        const noPreviewRes = await fetch(`${baseUrl}/config`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project: 'p1',
                config: { setting: 'new-value' },
                current_hash: initialHash,
                operator: 'alice',
            }),
        });
        assert.equal(noPreviewRes.status, 409);
        const noPreviewBody = await noPreviewRes.json();
        assert.equal(noPreviewBody.error, 'PREVIEW_REQUIRED');

        // 6. POST /config with preview_hash and current_hash succeeds (version +1)
        const saveRes = await fetch(`${baseUrl}/config`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project: 'p1',
                config: { setting: 'new-value' },
                current_hash: initialHash,
                preview_hash: previewBody.preview_hash,
                operator: 'alice',
            }),
        });
        assert.equal(saveRes.status, 200);
        const saveBody = await saveRes.json();
        assert.equal(saveBody.ok, true);
        assert.equal(saveBody.version, 2);

        // 7. Stale current_hash returns 409 STALE_VERSION
        const staleRes = await fetch(`${baseUrl}/config`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project: 'p1',
                config: { setting: 'attempt-stale' },
                current_hash: initialHash, // stale!
                preview_hash: 'dummy_preview',
                operator: 'alice',
            }),
        });
        assert.equal(staleRes.status, 409);
        const staleBody = await staleRes.json();
        assert.equal(staleBody.error, 'STALE_VERSION');

        // 8. GET /work-overview returns text/html work overview
        const { ensureEvidenceSchema, recordTurnEvidence } = await import('../eso/adapters/src/host-bridge.mjs');
        // D-93: the host bridge is async now — the fixture must finish before the endpoint reads.
        await ensureEvidenceSchema(db);
        await recordTurnEvidence({
            db,
            project: 'p1',
            turnId: 'turn-nest-1',
            actorRole: 'lead',
            actorStatus: 'FULL',
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { command: 'bun test' },
        });

        const s1Res = await fetch(`${baseUrl}/work-overview?project=p1`, {
            headers: {
                'Authorization': `Bearer ${BEARER_SAMPLE}`,
            },
        });
        assert.equal(s1Res.status, 200);
        assert.match(s1Res.headers.get('content-type'), /text\/html/);
        const s1Html = await s1Res.text();
        assert.match(s1Html, /Dự án: p1/);
        assert.match(s1Html, /data-turn-id="turn-nest-1"/);
    } finally {
        await app.close();
        await pg.cleanup();
    }
});

test('ESO-370 / D-71: NestJS + Fastify /health returns 503 when store fails', async () => {
    const brokenDb = {
        get() { throw new Error('DB connection failed'); },
    };
    const app = await createNestFastifyControlPlane({ db: brokenDb });
    await app.listen(0, '127.0.0.1');
    const fastifyInstance = app.getHttpAdapter().getInstance();
    const serverAddr = fastifyInstance.server.address();
    const baseUrl = `http://127.0.0.1:${serverAddr.port}`;

    try {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'unhealthy');
        assert.equal(body.error, 'STORE_UNAVAILABLE');
    } finally {
        await app.close();
    }
});
