import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from './helpers/test-pg-db.mjs';
import { initSchema } from '../eso/graph/src/schema.mjs';
import { initConfigSchema } from '../eso/control-plane/src/modules/config/infrastructure/persistence/config.schema.ts';
import { saveConfig } from '../eso/control-plane/src/modules/config/infrastructure/persistence/repositories/config.repository.ts';
import { createNestFastifyControlPlane } from '../eso/control-plane/dist/main.js';

async function createTestDb() {
    const pg = await createTestPgDb();
    await initSchema(pg.db);
    await initConfigSchema(pg.db);
    return pg;
}

const TOKEN = 'test-token';

test('Tenant Context: token project A + request project A returns 200 OK', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    const projectA = 'proj-alpha';

    await saveConfig(db, {
        project: projectA,
        config: { tenant: 'alpha' },
        operator: 'test-init',
    });

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN,
        authProject: projectA,
    });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        const res = await fetch(`${base}/config?project=${projectA}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.project, projectA);
    } finally {
        await app.close();
        await pg.cleanup();
    }
});

test('Tenant Context: token project A + request query/body project B returns 403 OUT_OF_SCOPE', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    const projectA = 'proj-alpha';
    const projectB = 'proj-beta';

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN,
        authProject: projectA,
    });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        // 1. Query parameter mismatch returns 403 OUT_OF_SCOPE
        const queryRes = await fetch(`${base}/config?project=${projectB}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(queryRes.status, 403);
        const queryBody = await queryRes.json();
        assert.equal(queryBody.code, 'OUT_OF_SCOPE');

        // 2. Request body mismatch returns 403 OUT_OF_SCOPE
        const bodyRes = await fetch(`${base}/config/preview`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project: projectB,
                pendingChange: { key: 'value' },
            }),
        });
        assert.equal(bodyRes.status, 403);
        const bodyResData = await bodyRes.json();
        assert.equal(bodyResData.code, 'OUT_OF_SCOPE');
    } finally {
        await app.close();
        await pg.cleanup();
    }
});

test('Tenant Context: missing authProject fails closed with 403 AUTH_PROJECT_MISSING', async () => {
    const pg = await createTestDb();
    const db = pg.db;

    // Server started without authProject and without ESO_AUTH_PROJECT
    const originalEnv = process.env.ESO_AUTH_PROJECT;
    delete process.env.ESO_AUTH_PROJECT;

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN,
        authProject: null,
    });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        const res = await fetch(`${base}/config?project=proj-alpha`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 403);
        const body = await res.json();
        assert.equal(body.code, 'AUTH_PROJECT_MISSING');
    } finally {
        if (originalEnv !== undefined) {
            process.env.ESO_AUTH_PROJECT = originalEnv;
        }
        await app.close();
        await pg.cleanup();
    }
});

test('Tenant Context: Fastify request context receives request.esoProject', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    const projectA = 'proj-context-test';

    await saveConfig(db, {
        project: projectA,
        config: { tenant: 'context' },
        operator: 'test-init',
    });

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN,
        authProject: projectA,
    });

    // Register a fastify onResponse hook to inspect request.esoProject
    let capturedEsoProject = null;
    const fastifyInstance = app.getHttpAdapter().getInstance();
    fastifyInstance.addHook('onResponse', async (req, reply) => {
        if (req.raw.url?.startsWith('/config')) {
            capturedEsoProject = req.esoProject;
        }
    });

    await app.listen(0, '127.0.0.1');
    const port = fastifyInstance.server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        const res = await fetch(`${base}/config?project=${projectA}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        assert.equal(capturedEsoProject, projectA, 'request.esoProject must match authenticated project scope');
    } finally {
        await app.close();
        await pg.cleanup();
    }
});
