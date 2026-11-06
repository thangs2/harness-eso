import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph } from '../../../eso/graph/src/roslyn-adapter.mjs';

const FIXTURE_CSPROJ = fileURLToPath(new URL('../../fixtures/csharp/SimpleMonolith/SimpleMonolith.csproj', import.meta.url));

test('SCN-GRAPH-03 · AC-GRAPH-01-03 — cùng build_id ⇒ id ổn định', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        const project = 'project-idempotent';
        const buildId = 'build-fixed-100';

        // Run 1
        const run1 = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        const nodeCountAfterRun1 = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        const edgeCountAfterRun1 = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_edge WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        const claimCountAfterRun1 = (await db.all(
            "SELECT count(*)::int AS cnt FROM source_claim WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        assert.ok(nodeCountAfterRun1 > 0);
        assert.ok(edgeCountAfterRun1 > 0);

        // Run 2 with the exact same build_id
        const run2 = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        const nodeCountAfterRun2 = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        const edgeCountAfterRun2 = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_edge WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        const claimCountAfterRun2 = (await db.all(
            "SELECT count(*)::int AS cnt FROM source_claim WHERE project = $1 AND build_id = $2",
            [project, buildId]
        ))[0].cnt;

        // Idempotency: count must NOT double
        assert.equal(nodeCountAfterRun2, nodeCountAfterRun1, 'Node count must not duplicate on same build_id');
        assert.equal(edgeCountAfterRun2, edgeCountAfterRun1, 'Edge count must not duplicate on same build_id');
        assert.equal(claimCountAfterRun2, claimCountAfterRun1, 'Claim count must not duplicate on same build_id');

        // IDs must match exactly
        assert.deepEqual(
            run1.nodes.map(n => n.node_id).sort(),
            run2.nodes.map(n => n.node_id).sort(),
            'Node logical IDs must be identical across runs'
        );
    } finally {
        await pg.cleanup();
    }
});
