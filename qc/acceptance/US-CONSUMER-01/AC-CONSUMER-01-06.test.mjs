import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from '../../helpers/test-pg-db.mjs';
import { createNestFastifyControlPlane } from '../../../eso/control-plane/dist/main.js';
import { ensureConsumerSchema } from '../../../eso/control-plane/src/modules/consumers/infrastructure/persistence/consumer.schema.js';

const TOKEN = 'test-bearer-token';

test('SCN-CONSUMER-06 · AC-CONSUMER-01-06 — consumer tenant isolation', async () => {
    const pg = await createTestPgDb();
    const db = pg.db;

    await ensureConsumerSchema(db);

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
        const res = await fetch(`${base}/api/v1/consumers`, {
            headers: {
                Authorization: `Bearer ${TOKEN}`,
            },
        });
        assert.equal(res.status, 403);
        const body = await res.json();
        assert.equal(body.code, 'AUTH_PROJECT_MISSING');

        const projects = await db.all('SELECT * FROM project');
        assert.equal(projects.length, 0, 'missing auth project must not write');
    } finally {
        if (originalEnv !== undefined) {
            process.env.ESO_AUTH_PROJECT = originalEnv;
        }
        await app.close();
        await pg.cleanup();
    }
});
