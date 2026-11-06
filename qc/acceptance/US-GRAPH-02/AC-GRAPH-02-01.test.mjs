import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-docs';
const BUILD = 'build-docs';
const TOKEN = 'graph-acceptance-token';

test('SCN-GRAPH-07 · AC-GRAPH-02-01 — doc + relation specifies/constrains', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
             (?, ?, 'target', 'method', 'OrderService.Create', 'src/order-service.ts'),
             (?, ?, 'doc-spec', 'doc', 'docs/spec.md', 'docs/spec.md'),
             (?, ?, 'doc-constraint', 'doc', 'docs/constraint.md', 'docs/constraint.md'),
             (?, ?, 'doc-derived', 'doc', 'docs/derived.md', 'docs/derived.md')`,
            Array(4).fill([PROJECT, BUILD]).flat()
        );
        await db.run(
            `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
             (?, ?, 'e-spec', 'doc-spec', 'target', 'specifies', false),
             (?, ?, 'e-constraint', 'doc-constraint', 'target', 'constrains', false),
             (?, ?, 'e-derived', 'target', 'doc-derived', 'derived_from', false)`,
            Array(3).fill([PROJECT, BUILD]).flat()
        );

        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });
        const res = await postGraph(api.baseUrl, '/v1/graph/docs', {
            build_id: BUILD,
            node: { kind: 'method', id: 'OrderService.Create' },
        }, { token: TOKEN });
        const text = await res.text();
        assert.equal(res.status, 200, `docs query must answer: ${text}`);
        const body = JSON.parse(text);

        assert.equal(body.status, 'ready');
        const byPath = new Map(body.docs.map((d) => [d.doc_path, d]));
        assert.ok(byPath.has('docs/spec.md'), 'anchored doc must be returned');
        assert.equal(byPath.get('docs/spec.md').relation, 'specifies');
        assert.deepEqual(byPath.get('docs/spec.md').via, ['docs/spec.md', 'OrderService.Create']);
        assert.ok(byPath.has('docs/constraint.md'), 'constrains relation must be returned');
        assert.equal(byPath.get('docs/constraint.md').relation, 'constrains');
        assert.ok(byPath.has('docs/derived.md'), 'derived_from relation must be returned in either direction');
        assert.equal(byPath.get('docs/derived.md').relation, 'derived_from');

        // The relation is a stored edge, not a similarity ranking.
        const stored = await db.all(
            `SELECT kind FROM graph_edge WHERE project = ? AND build_id = ? ORDER BY edge_id`,
            [PROJECT, BUILD]
        );
        assert.deepEqual(stored.map((r) => r.kind), ['constrains', 'derived_from', 'specifies']);
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
