import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-turn';
const BUILD = 'build-turn';
const TOKEN = 'graph-acceptance-token';
const TURN_HEADER = { 'x-eso-turn-phase': 'judging' };

test('SCN-GRAPH-15 · AC-GRAPH-03-05 — query nặng trên turn ⇒ HEAVY_ON_TURN', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES (?, ?, 'n_turn', 'method', 'TurnSymbol', 'src/turn.ts')`,
            [PROJECT, BUILD]
        );
        await db.run(
            `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
             VALUES (?, ?, 'Q1', ?, 1.0, now())`,
            [PROJECT, BUILD, { file: 1.0, class: 1.0, method: 1.0 }]
        );

        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });

        // 1. A graph query that declares itself turn-scoped is refused, not executed.
        const turned = await postGraph(api.baseUrl, '/v1/graph/q1', {
            build_id: BUILD,
            symbol: 'TurnSymbol',
        }, { token: TOKEN, headers: TURN_HEADER });
        const turnedText = await turned.text();
        assert.equal(turned.status, 409, `turn-path query must be refused: ${turnedText}`);
        const turnedBody = JSON.parse(turnedText);
        assert.equal(turnedBody.code, 'HEAVY_ON_TURN');

        // 2. Indexing is heavy too and must be refused under the same context.
        const turnIndex = await postGraph(api.baseUrl, '/v1/graph/index', {
            build_id: BUILD,
            source: { kind: 'roslyn', solution_path: 'src/App.sln' },
        }, { token: TOKEN, headers: TURN_HEADER });
        assert.equal(turnIndex.status, 409);
        assert.equal((await turnIndex.json()).code, 'HEAVY_ON_TURN');

        // 3. The refusal did not run the query and did not mutate the graph: the same call
        //    off-path still answers, so the turn is not left blocked by the heavy request.
        const before = await db.get(
            'SELECT count(*)::int AS c FROM graph_node WHERE project = ? AND build_id = ?',
            [PROJECT, BUILD]
        );
        const offPath = await postGraph(api.baseUrl, '/v1/graph/q1', {
            build_id: BUILD,
            symbol: 'TurnSymbol',
        }, { token: TOKEN });
        assert.equal(offPath.status, 200);
        const after = await db.get(
            'SELECT count(*)::int AS c FROM graph_node WHERE project = ? AND build_id = ?',
            [PROJECT, BUILD]
        );
        assert.equal(Number(after.c), Number(before.c), 'a refused turn-path request must not mutate the graph');
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
