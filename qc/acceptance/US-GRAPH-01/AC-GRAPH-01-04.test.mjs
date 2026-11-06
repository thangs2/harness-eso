import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph, indexGraphApi28 } from '../../../eso/graph/src/roslyn-adapter.mjs';

const FIXTURE_CSPROJ = fileURLToPath(new URL('../../fixtures/csharp/SimpleMonolith/SimpleMonolith.csproj', import.meta.url));

test('SCN-GRAPH-04 · AC-GRAPH-01-04 — gọi trên turn ⇒ HEAVY_ON_TURN', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        const project = 'project-turn-test';
        const buildId = 'build-turn-999';

        // 1. Invoking extractRoslynGraph on turn path must reject with HEAVY_ON_TURN
        await assert.rejects(
            async () => {
                await extractRoslynGraph({
                    project,
                    build_id: buildId,
                    solution_path: FIXTURE_CSPROJ,
                    onTurnPath: true, // on turn path
                    db,
                });
            },
            (err) => {
                assert.ok(
                    err.message.includes('HEAVY_ON_TURN') || err.code === 'HEAVY_ON_TURN' || err.status === 409,
                    `Expected HEAVY_ON_TURN error, got: ${err.message}`
                );
                return true;
            }
        );

        // 2. Invoking API-28 endpoint on turn path must return 409 HEAVY_ON_TURN
        const apiResponse = await indexGraphApi28(
            {
                project,
                build_id: buildId,
                source: { kind: 'roslyn', solution_path: FIXTURE_CSPROJ },
            },
            { onTurnPath: true, db }
        );

        assert.equal(apiResponse.status, 409, 'API-28 must return HTTP 409 on turn path');
        assert.equal(apiResponse.code || apiResponse.data?.error, 'HEAVY_ON_TURN');

        // 3. Exactly 0 rows written to database
        const nodes = await db.all("SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1", [project]);
        assert.equal(nodes[0].cnt, 0, 'Zero nodes must be written when rejected on turn path');

        const edges = await db.all("SELECT count(*)::int AS cnt FROM graph_edge WHERE project = $1", [project]);
        assert.equal(edges[0].cnt, 0, 'Zero edges must be written when rejected on turn path');
    } finally {
        await pg.cleanup();
    }
});
