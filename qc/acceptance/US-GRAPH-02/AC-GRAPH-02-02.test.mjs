import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-docs-unlinked';
const BUILD = 'build-docs-unlinked';
const TOKEN = 'graph-acceptance-token';

test('SCN-GRAPH-08 · AC-GRAPH-02-02 — doc không anchor ⇒ unknown', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, ?, 'target', 'method', 'UnanchoredTarget', 'src/target.ts'),
             (?, ?, 'doc-orphan', 'doc', 'docs/orphan.md', 'docs/orphan.md')`,
            Array(2).fill([PROJECT, BUILD]).flat()
        );

        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });
        const res = await postGraph(api.baseUrl, '/v1/graph/docs', {
            build_id: BUILD,
            node: { kind: 'method', id: 'UnanchoredTarget' },
        }, { token: TOKEN });
        const text = await res.text();
        assert.equal(res.status, 200, `unlinked doc is unknown, not an error: ${text}`);
        const body = JSON.parse(text);

        assert.equal(body.status, 'unknown', 'an unanchored doc must not become "no doc" or a similarity guess');
        assert.notEqual(body.status, 'ready');
        assert.equal(body.code, 'UNLINKED_DOC');
        assert.deepEqual(body.docs, [], 'no relation may be invented for an unanchored doc');
        assert.ok(Array.isArray(body.unknowns) && body.unknowns.length > 0, 'unknowns[] must say the doc is unlinked');
        assert.ok(
            JSON.stringify(body.unknowns).includes('docs/orphan.md'),
            'the unlinked doc must be named in unknowns[] so it is visible'
        );
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
