import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const BUILD = 'build-tenant';
const TOKEN = 'graph-acceptance-token';

async function seedProject(db, project, symbol, path) {
    await db.run(
        `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
         VALUES (?, ?, ?, 'method', ?, ?)`,
        [project, BUILD, `${project}-node`, symbol, path]
    );
    await db.run(
        `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
         VALUES (?, ?, 'Q1', ?, 1.0, now())`,
        [project, BUILD, { file: 1.0, class: 1.0, method: 1.0 }]
    );
}

test('SCN-GRAPH-13 · AC-GRAPH-03-03 — query chéo project ⇒ OUT_OF_SCOPE', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await seedProject(db, PROJECT_A, 'SymbolA', 'src/a.ts');
        await seedProject(db, PROJECT_B, 'SecretB', 'src/secret-b.ts');

        api = await startGraphApi({ db, project: PROJECT_A, token: TOKEN });

        // 1. Asking for B while authenticated as A is refused by the project scope.
        const cross = await postGraph(api.baseUrl, '/v1/graph/q1', {
            project: PROJECT_B,
            build_id: BUILD,
            symbol: 'SecretB',
        }, { token: TOKEN });
        const crossText = await cross.text();
        assert.equal(cross.status, 403, `cross-project body must be refused: ${crossText}`);
        const crossBody = JSON.parse(crossText);
        assert.equal(crossBody.code, 'OUT_OF_SCOPE');

        // 2. Without a body project the server uses the authenticated project; B's rows must not leak.
        const scoped = await postGraph(api.baseUrl, '/v1/graph/q1', {
            build_id: BUILD,
            symbol: 'SecretB',
        }, { token: TOKEN });
        assert.equal(scoped.status, 200);
        const scopedBody = await scoped.json();
        assert.equal(scopedBody.project, PROJECT_A, 'project comes from auth context, never the body');
        const serialized = JSON.stringify(scopedBody);
        assert.ok(!serialized.includes('src/secret-b.ts'), 'rows of project B must not leak into project A');
        assert.ok(!serialized.includes('SecretB'), 'symbols of project B must not leak into project A');
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
