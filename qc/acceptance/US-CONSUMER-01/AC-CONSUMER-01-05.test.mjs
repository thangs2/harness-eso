import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from '../../helpers/test-pg-db.mjs';
import { createNestFastifyControlPlane } from '../../../eso/control-plane/dist/main.js';
import { ensureConsumerSchema } from '../../../eso/control-plane/src/modules/consumers/infrastructure/persistence/consumer.schema.js';

function makeProfile(id) {
    return {
        id,
        name: `Consumer ${id}`,
        root: `/tmp/${id}`,
        repoUrl: `git@example.com:${id}/repo.git`,
        hostMode: 'dual-ide',
        observePort: 8792,
        sdlcRoot: 'sdlc',
        profile: { recipe: 'pro', hostProfile: 'cursor-superset', description: 'Test' },
        integration: { jevMode: 'off', consent: true, hostPack: 'full', memoryAdapter: 'none' },
        zones: [
            { name: 'human', path: 'sdlc', headerProfile: 'human-v1' },
            { name: 'agent', path: '.agents', headerProfile: 'agent-v1' },
        ],
        headerProfile: 'standard-v1',
        presetVersion: '2026-11',
        tools: { jira: true, notion: false, plan: true },
        team: { roles: ['lead', 'build', 'verify', 'audit'] },
        gates: { design: true, build: true, verify: true, release: true },
        sources: { docgraph: true, codegraph: true, memory: false },
        protectedPaths: ['AGENTS.md', '.cursor/rules/', 'sdlc/'],
    };
}

const TOKEN_A = 'test-bearer-token-alpha';

test('SCN-CONSUMER-05 · AC-CONSUMER-01-05 — consumer tenant isolation', async () => {
    const pg = await createTestPgDb();
    const db = pg.db;
    const projectA = 'proj-alpha';
    const projectB = 'proj-beta';

    await ensureConsumerSchema(db);
    const now = new Date().toISOString();

    // Seed profile B
    await db.run('INSERT INTO project (project) VALUES (?) ON CONFLICT DO NOTHING', [projectB]);
    await db.run(
        `INSERT INTO sdlc_profile
         (project, version, name, root, sdlc_root, profile_json, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, 'sdlc', ?, 'current', ?, ?)`,
        [projectB, `Consumer ${projectB}`, `/tmp/${projectB}`, JSON.stringify(makeProfile(projectB)), now, now]
    );

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN_A,
        authProject: projectA,
    });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        // 1. GET /api/v1/consumers/proj-beta with token A -> 403 OUT_OF_SCOPE
        const getRes = await fetch(`${base}/api/v1/consumers/${projectB}`, {
            headers: {
                Authorization: `Bearer ${TOKEN_A}`,
            },
        });
        assert.equal(getRes.status, 403);
        const getBody = await getRes.json();
        assert.equal(getBody.code, 'OUT_OF_SCOPE');

        // 2. PUT /api/v1/consumers/proj-beta with token A -> 403 OUT_OF_SCOPE
        const putRes = await fetch(`${base}/api/v1/consumers/${projectB}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${TOKEN_A}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(makeProfile(projectB)),
        });
        assert.equal(putRes.status, 403);
        const putBody = await putRes.json();
        assert.equal(putBody.code, 'OUT_OF_SCOPE');

        // Verify profile B version has not changed
        const rows = await db.all('SELECT version FROM sdlc_profile WHERE project = ?', [projectB]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].version, 1);
    } finally {
        await app.close();
        await pg.cleanup();
    }
});
