import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-lowcoverage';
const BUILD = 'build-lowcoverage';
const TOKEN = 'graph-acceptance-token';

test('SCN-GRAPH-14 · AC-GRAPH-03-04 — coverage dưới floor ⇒ unknown', { timeout: 120000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES (?, ?, 'n_partial', 'method', 'PartialSymbol', 'src/partial.ts')`,
            [PROJECT, BUILD]
        );
        await db.run(
            `INSERT INTO completeness (project, build_id, question, per_kind, value, measured_at)
             VALUES (?, ?, 'Q1', ?, 0.3, now())`,
            [PROJECT, BUILD, { file: 1.0, class: 0.3, method: 1.0 }]
        );

        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });

        const res = await postGraph(api.baseUrl, '/v1/graph/q1', {
            build_id: BUILD,
            symbol: 'PartialSymbol',
        }, { token: TOKEN });

        const text = await res.text();
        assert.equal(res.status, 200, `below-floor answer is 200 with status unknown: ${text}`);
        const body = JSON.parse(text);

        assert.equal(body.status, 'unknown', 'coverage 0.3 must not be treated as sufficient');
        assert.notEqual(body.status, 'absent', 'BR-05: below floor is unknown, never absent');
        assert.equal(body.code, 'LOW_COVERAGE');
        assert.equal(body.completeness?.question, 'Q1');
        assert.equal(body.completeness?.value, 0.3);
        assert.ok(Number(body.completeness?.floor) > 0.3, 'floor must be reported so the caller can see the gap');
        assert.ok(Array.isArray(body.unknowns) && body.unknowns.length > 0, 'unknowns[] must name what is missing');
        assert.ok(!JSON.stringify(body).includes('src/partial.ts'),
            'below floor must not hand back a read set as if it were an answer');
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
