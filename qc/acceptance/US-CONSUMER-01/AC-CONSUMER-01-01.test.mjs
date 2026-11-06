import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from '../../helpers/test-pg-db.mjs';
import { createNestFastifyControlPlane } from '../../../eso/control-plane/dist/main.js';

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

test('SCN-CONSUMER-01 · AC-CONSUMER-01-01 — consumer tenant isolation', async () => {
    const pg = await createTestPgDb();
    const db = pg.db;
    const projectA = 'proj-alpha';

    const app = await createNestFastifyControlPlane({
        db,
        authToken: TOKEN_A,
        authProject: projectA,
    });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpAdapter().getInstance().server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
        const res = await fetch(`${base}/api/v1/consumers`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN_A}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(makeProfile(projectA)),
        });

        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.id, projectA);

        const rows = await db.all('SELECT * FROM sdlc_profile WHERE project = ?', [projectA]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].project, projectA);
    } finally {
        await app.close();
        await pg.cleanup();
    }
});
