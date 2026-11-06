import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph } from '../../../eso/graph/src/roslyn-adapter.mjs';

const FIXTURE_CSPROJ = fileURLToPath(new URL('../../fixtures/csharp/SimpleMonolith/SimpleMonolith.csproj', import.meta.url));

test('SCN-GRAPH-01 · AC-GRAPH-01-01 — node/edge canonical + logical_id', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        const project = 'project-monolith';
        const buildId = 'build-101';

        // Run extractor once
        const res1 = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        // Run extractor second time with same build_id to verify logical_id stability
        const res2 = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        assert.ok(res1.nodes.length > 0, 'Expected extracted nodes from C# fixture');
        assert.ok(res1.edges.length > 0, 'Expected extracted edges from C# fixture');

        // Check canonical kinds: class, method, entity, dto, namespace, module, etc.
        const CANONICAL_KINDS = new Set([
            'module', 'namespace', 'class', 'method', 'entity', 'dto', 'table',
            'endpoint', 'permission', 'app_service', 'service', 'route', 'doc'
        ]);
        for (const n of res1.nodes) {
            assert.ok(CANONICAL_KINDS.has(n.kind), `Node kind ${n.kind} must be canonical`);
            assert.ok(n.path, `Node ${n.node_key} must have path`);
            assert.ok(n.node_id, `Node ${n.node_key} must have node_id`);
        }

        // logical_id stability: running twice produces identical node_ids
        const ids1 = res1.nodes.map(n => n.node_id).sort();
        const ids2 = res2.nodes.map(n => n.node_id).sort();
        assert.deepEqual(ids1, ids2, 'logical_id must be stable across runs, not sequential numbers');

        // Source claims: every edge must have provenance
        assert.ok(res1.source_claims.length > 0, 'source_claims must not be empty');
        const claimEdgeIds = new Set(res1.source_claims.map(sc => sc.edge_id));
        for (const edge of res1.edges) {
            assert.ok(claimEdgeIds.has(edge.edge_id), `Edge ${edge.edge_id} (${edge.kind}) must have a corresponding source_claim`);
        }
        for (const sc of res1.source_claims) {
            assert.equal(sc.source_kind, 'roslyn', 'source_kind must be roslyn');
            assert.ok(sc.claim && sc.claim.length > 0, 'claim text must not be empty');
        }

        // Verify DB persistence in PostgreSQL
        const dbNodes = await db.all("SELECT * FROM graph_node WHERE project = $1 AND build_id = $2", [project, buildId]);
        assert.equal(dbNodes.length, res1.nodes.length, 'Database graph_node count must match extracted nodes');

        const dbEdges = await db.all("SELECT * FROM graph_edge WHERE project = $1 AND build_id = $2", [project, buildId]);
        assert.equal(dbEdges.length, res1.edges.length, 'Database graph_edge count must match extracted edges');

        const dbClaims = await db.all("SELECT * FROM source_claim WHERE project = $1 AND build_id = $2", [project, buildId]);
        assert.equal(dbClaims.length, res1.source_claims.length, 'Database source_claim count must match extracted claims');
    } finally {
        await pg.cleanup();
    }
});
