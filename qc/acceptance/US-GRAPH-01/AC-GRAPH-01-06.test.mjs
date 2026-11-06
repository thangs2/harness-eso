import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph } from '../../../eso/graph/src/roslyn-adapter.mjs';

const FIXTURE_CSPROJ = fileURLToPath(new URL('../../fixtures/csharp/SimpleMonolith/SimpleMonolith.csproj', import.meta.url));

test('SCN-GRAPH-06 · AC-GRAPH-01-06 — tenant isolation / RLS', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    const appRole = `app_role_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
        const projectB = 'project-tenant-B';
        const projectA = 'project-tenant-A';
        const buildId = 'build-rls-1';

        // 1. Populate Project B
        await extractRoslynGraph({
            project: projectB,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        const bNodeCount = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1",
            [projectB]
        ))[0].cnt;
        assert.ok(bNodeCount > 0, 'Project B must have nodes');

        // 2. Extract Project A
        await extractRoslynGraph({
            project: projectA,
            build_id: buildId,
            solution_path: FIXTURE_CSPROJ,
            onTurnPath: false,
            db,
        });

        // 3. Verify total nodes for Project B is completely unchanged
        const bNodeCountAfter = (await db.all(
            "SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1",
            [projectB]
        ))[0].cnt;
        assert.equal(bNodeCountAfter, bNodeCount, 'Project B rows must remain unaffected by Project A extraction');

        // 4. Test DB: app role non-superuser + RLS enforcement (INV-GR-03 / D-92 / 26.graph-schema §5)
        await db.exec(`
            CREATE ROLE ${appRole} NOLOGIN;
            GRANT USAGE ON SCHEMA ${pg.schema} TO ${appRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${pg.schema} TO ${appRole};
        `);

        // Switch to non-superuser app role with session setting eso.project = projectA
        await db.exec(`SET ROLE ${appRole};`);
        await db.exec(`SET eso.project = '${projectA}';`);

        const visibleNodesForA = await db.all("SELECT * FROM graph_node");
        assert.ok(visibleNodesForA.length > 0, 'Project A should see its own nodes');
        for (const node of visibleNodesForA) {
            assert.equal(node.project, projectA, 'RLS must not leak rows from Project B to Project A');
        }

        // Project A must not see any edges or claims from Project B either
        const visibleEdgesForA = await db.all("SELECT * FROM graph_edge");
        for (const edge of visibleEdgesForA) {
            assert.equal(edge.project, projectA, 'RLS must isolate graph_edge');
        }

        const visibleClaimsForA = await db.all("SELECT * FROM source_claim");
        for (const claim of visibleClaimsForA) {
            assert.equal(claim.project, projectA, 'RLS must isolate source_claim');
        }

        // Reset role and session
        await db.exec("RESET ROLE;");
        await db.exec("RESET eso.project;");
    } finally {
        try {
            await db.exec(`RESET ROLE;`);
            await db.exec(`DROP OWNED BY ${appRole};`);
            await db.exec(`DROP ROLE IF EXISTS ${appRole};`);
        } catch {}
        await pg.cleanup();
    }
});
