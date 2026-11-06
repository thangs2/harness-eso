import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-q1q5';
const BUILD = 'build-q1q5';
const TOKEN = 'graph-acceptance-token';

async function seed(db) {
    await db.run(
        `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path) VALUES
         (?, ?, 'n_target', 'method', 'TargetSymbol', 'src/target.ts'),
         (?, ?, 'n_caller', 'method', 'Caller', 'src/caller.ts'),
         (?, ?, 't_orders', 'table', 'orders', 'db/orders.sql'),
         (?, ?, 'm_a', 'module', 'ModuleA', 'src/a.ts'),
         (?, ?, 'm_b', 'module', 'ModuleB', 'src/b.ts'),
         (?, ?, 'ep_x', 'endpoint', 'GET /x', 'src/x.ts'),
         (?, ?, 'perm_x', 'permission', 'orders.read', 'src/perm.ts'),
         (?, ?, 'grant_x', 'permission', 'grant:orders.read', 'src/grant.ts'),
         (?, ?, 'slice-1', 'module', 'slice-1', 'src/slice.ts')`,
        Array(9).fill([PROJECT, BUILD]).flat()
    );

    await db.run(
        `INSERT INTO graph_edge (project, build_id, edge_id, from_node_id, to_node_id, kind, conflict) VALUES
         (?, ?, 'e_ref', 'n_caller', 'n_target', 'references', false),
         (?, ?, 'e_cycle_a', 'm_a', 'm_b', 'depends_on', false),
         (?, ?, 'e_cycle_b', 'm_b', 'm_a', 'depends_on', false),
         (?, ?, 'e_req', 'ep_x', 'perm_x', 'requires', false),
         (?, ?, 'e_def', 'perm_x', 'grant_x', 'defines', false),
         (?, ?, 'e_tenant', 'slice-1', 't_orders', 'tenant_marker', false)`,
        Array(6).fill([PROJECT, BUILD]).flat()
    );

    const completeness = [
        ['Q1', 0.96, { file: 0.96, class: 0.96, method: 0.96 }],
        ['Q2', 0.91, { table: 0.91, entity: 0.91, column: 0.91 }],
        ['Q3', 0.97, { module: 0.97, package: 0.97 }],
        ['Q4', 1.0, { endpoint: 1.0, permission: 1.0, grant: 1.0 }],
        ['Q5', 0.95, { slice: 0.95, table: 0.95, tenant_marker: 0.95 }],
    ];
    for (const [question, value, perKind] of completeness) {
        await db.run(
            `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
             VALUES (?, ?, ?, ?, ?, now())`,
            [PROJECT, BUILD, question, perKind, value]
        );
    }
}

test('SCN-GRAPH-11 · AC-GRAPH-03-01 — completeness theo từng câu', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await seed(db);
        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });

        const cases = [
            { route: '/v1/graph/q1', body: { build_id: BUILD, symbol: 'TargetSymbol' }, question: 'Q1', value: 0.96 },
            { route: '/v1/graph/q2', body: { build_id: BUILD, table: 'orders' }, question: 'Q2', value: 0.91 },
            { route: '/v1/graph/q3', body: { build_id: BUILD }, question: 'Q3', value: 0.97 },
            { route: '/v1/graph/q4', body: { build_id: BUILD, endpoint_id: 'GET /x' }, question: 'Q4', value: 1.0 },
            { route: '/v1/graph/q5', body: { build_id: BUILD, slice_id: 'slice-1' }, question: 'Q5', value: 0.95 },
        ];

        for (const tc of cases) {
            const res = await postGraph(api.baseUrl, tc.route, tc.body, { token: TOKEN });
            const text = await res.text();
            assert.equal(res.status, 200, `${tc.question}: expected 200, got ${res.status}: ${text}`);
            const body = JSON.parse(text);

            assert.equal(body.question, tc.question, `${tc.question}: response must name its question`);
            assert.equal(body.completeness?.question, tc.question,
                `${tc.question}: completeness must belong to THIS question, not another`);
            assert.equal(body.completeness?.value, tc.value,
                `${tc.question}: completeness value must come from the row of this question`);
            assert.equal(body.status, 'ready', `${tc.question}: warm graph must answer ready`);
            assert.ok(body.answer && typeof body.answer === 'object', `${tc.question}: answer required`);
            assert.ok(Array.isArray(body.unknowns), `${tc.question}: unknowns[] required`);
        }

        // The generic form names the question in the body; it must use Q2's completeness too.
        const generic = await postGraph(api.baseUrl, '/v1/graph/query', {
            question: 'Q2',
            build_id: BUILD,
            table: 'orders',
        }, { token: TOKEN });
        const genericText = await generic.text();
        assert.equal(generic.status, 200, `generic query must answer: ${genericText}`);
        const genericBody = JSON.parse(genericText);
        assert.equal(genericBody.completeness?.question, 'Q2');
        assert.equal(genericBody.completeness?.value, 0.91);
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
