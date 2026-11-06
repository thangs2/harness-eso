import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph } from '../../../eso/graph/src/roslyn-adapter.mjs';

const BROKEN_CSPROJ = fileURLToPath(new URL('../../fixtures/csharp/BrokenMonolith/BrokenMonolith.csproj', import.meta.url));

test('SCN-GRAPH-02 · AC-GRAPH-01-02 — parse lỗi ⇒ failed_file + unknown', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        const project = 'project-broken';
        const buildId = 'build-broken-1';

        const res = await extractRoslynGraph({
            project,
            build_id: buildId,
            solution_path: BROKEN_CSPROJ,
            onTurnPath: false,
            db,
        });

        // 1. failed_files is recorded with PARSE_FAILED
        assert.ok(res.failed_files.length > 0, 'Broken files must not be swallowed via catch/continue');
        const brokenEntry = res.failed_files.find(f => (typeof f === 'string' ? f : f.path).includes('Broken.cs'));
        assert.ok(brokenEntry, 'failed_files must include Broken.cs');
        if (typeof brokenEntry === 'object') {
            assert.equal(brokenEntry.error, 'PARSE_FAILED');
        }

        // 2. Zero fake/synthetic nodes or edges for the corrupted file
        assert.ok(
            !res.nodes.some(n => n.path && n.path.includes('Broken.cs')),
            'Must not emit fake or partial nodes for broken file'
        );

        // 3. Coverage is strictly reduced and status is unknown (BR-05: unknown != absent)
        assert.ok(res.coverage < 1.0, 'Coverage must decrease when a file fails to parse');
        assert.equal(res.status, 'unknown', 'Status must be unknown, never sufficient or absent');
        assert.notEqual(res.status, 'absent', 'BR-05: failed parse is unknown, NEVER absent');

        // 4. In PostgreSQL, no nodes from Broken.cs are saved
        const dbNodes = await db.all(
            "SELECT * FROM graph_node WHERE project = $1 AND path LIKE '%Broken.cs%'",
            [project]
        );
        assert.equal(dbNodes.length, 0, 'No broken file nodes in database');
    } finally {
        await pg.cleanup();
    }
});
