import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-docs-supersede';
const BUILD = 'build-docs-supersede';
const TOKEN = 'graph-acceptance-token';

test('SCN-GRAPH-09 · AC-GRAPH-02-03 — supersede ⇒ không trả bản cũ', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, ?, 'target', 'method', 'GovernedMethod', 'src/governed.ts'),
             (?, ?, 'doc-new', 'doc', 'docs/new.md', 'docs/new.md'),
             (?, ?, 'doc-old', 'doc', 'docs/old.md', 'docs/old.md')`,
            Array(3).fill([PROJECT, BUILD]).flat()
        );
        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             (?, ?, 'e-new-spec', 'doc-new', 'target', 'specifies', false),
             (?, ?, 'e-old-spec', 'doc-old', 'target', 'specifies', false),
             (?, ?, 'e-supersede', 'doc-new', 'doc-old', 'supersedes', false)`,
            Array(3).fill([PROJECT, BUILD]).flat()
        );

        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });
        const res = await postGraph(api.baseUrl, '/v1/graph/docs', {
            build_id: BUILD,
            node: { kind: 'method', id: 'GovernedMethod' },
        }, { token: TOKEN });
        const text = await res.text();
        assert.equal(res.status, 200, `supersede query must answer: ${text}`);
        const body = JSON.parse(text);

        const currentPaths = body.docs.map((d) => d.doc_path);
        assert.deepEqual(currentPaths, ['docs/new.md'], 'only the current doc may be returned as governing');
        assert.ok(!currentPaths.includes('docs/old.md'), 'the superseded doc must not be returned as current');

        assert.ok(Array.isArray(body.superseded), 'supersedes trace must be kept');
        const trace = body.superseded.find((s) => s.doc_path === 'docs/old.md');
        assert.ok(trace, 'the old doc must appear in the supersedes trace');
        assert.equal(trace.relation, 'supersedes');
        assert.equal(trace.superseded_by, 'docs/new.md');
        assert.deepEqual(trace.via, ['docs/old.md', 'docs/new.md']);
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
