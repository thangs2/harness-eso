import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT_A = 'project-docs-a';
const PROJECT_B = 'project-docs-b';
const BUILD = 'build-docs-tenant';
const TOKEN = 'graph-acceptance-token';

async function seedProject(db, project, targetId, docPath) {
    await db.run(
        `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
         (?, ?, ?, 'method', ?, 'src/target.ts'),
         (?, ?, ?, 'doc', ?, ?)`,
        [project, BUILD, `${project}-target`, targetId, project, BUILD, `${project}-doc`, docPath, docPath]
    );
    await db.run(
        `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict)
         VALUES (?, ?, ?, ?, ?, 'specifies', false)`,
        [project, BUILD, `${project}-edge`, `${project}-doc`, `${project}-target`]
    );
}

test('SCN-GRAPH-10 · AC-GRAPH-02-04 — doc project B không lộ', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await seedProject(db, PROJECT_A, 'TargetA', 'docs/a.md');
        await seedProject(db, PROJECT_B, 'TargetB', 'docs/b.md');

        api = await startGraphApi({ db, project: PROJECT_A, token: TOKEN });

        // 1. Asking for B's node while authenticated as A is refused.
        const cross = await postGraph(api.baseUrl, '/v1/graph/docs', {
            project: PROJECT_B,
            build_id: BUILD,
            node: { kind: 'method', id: 'TargetB' },
        }, { token: TOKEN });
        const crossText = await cross.text();
        assert.equal(cross.status, 403, `cross-project body must be refused: ${crossText}`);
        assert.equal(JSON.parse(crossText).code, 'OUT_OF_SCOPE');

        // 2. Without a body project the auth project is used; none of B's docs may appear.
        const scoped = await postGraph(api.baseUrl, '/v1/graph/docs', {
            build_id: BUILD,
            node: { kind: 'method', id: 'TargetB' },
        }, { token: TOKEN });
        const scopedText = await scoped.text();
        assert.equal(scoped.status, 200, `scoped docs query must answer: ${scopedText}`);
        const body = JSON.parse(scopedText);
        assert.ok(!JSON.stringify(body).includes('docs/b.md'), 'project B docs must not leak into project A');
        assert.equal(body.project, PROJECT_A, 'project comes from auth context, never the body');
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
