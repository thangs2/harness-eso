import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { extractRoslynGraph, indexGraphApi28 } from '../../../eso/graph/src/roslyn-adapter.mjs';

test('SCN-GRAPH-05 · AC-GRAPH-01-05 — thiếu SDK/build fail ⇒ TOOLCHAIN_UNAVAILABLE', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        const project = 'project-missing-sdk';
        const buildId = 'build-err-404';
        const nonExistentPath = 'src/NonExistent/DoesNotExist.sln';

        // 1. Adapter invocation on missing toolchain / missing solution
        await assert.rejects(
            async () => {
                await extractRoslynGraph({
                    project,
                    build_id: buildId,
                    solution_path: nonExistentPath,
                    onTurnPath: false,
                    db,
                });
            },
            (err) => {
                assert.ok(
                    err.message.includes('TOOLCHAIN_UNAVAILABLE') ||
                    err.code === 'TOOLCHAIN_UNAVAILABLE' ||
                    err.status === 503,
                    `Expected TOOLCHAIN_UNAVAILABLE, got: ${err.message}`
                );
                // Invariant: Do NOT report coverage = 0 (BR-05: unknown != absent, without denominator coverage is null/undefined/unknown)
                assert.notEqual(err.coverage, 0, 'Must NOT report coverage=0 on toolchain unavailability');
                return true;
            }
        );

        // 2. API-28 call on missing toolchain
        const apiResponse = await indexGraphApi28(
            {
                project,
                build_id: buildId,
                source: { kind: 'roslyn', solution_path: nonExistentPath },
            },
            { onTurnPath: false, db, consumerRoot: '/dummy/root' }
        );

        assert.equal(apiResponse.status, 503, 'API-28 must return HTTP 503 on toolchain unavailable');
        assert.equal(apiResponse.code || apiResponse.data?.error, 'TOOLCHAIN_UNAVAILABLE');
        assert.notEqual(apiResponse.data?.coverage, 0, 'Must NOT report coverage=0');

        // 3. Prefix-sibling escape: /tmp/croot must not authorize /tmp/croot-evil.
        const escapedResponse = await indexGraphApi28(
            {
                project,
                build_id: 'build-scope-escape',
                source: { kind: 'roslyn', solution_path: '../croot-evil/x.sln' },
            },
            { onTurnPath: false, db, consumerRoot: '/tmp/croot' }
        );
        assert.equal(escapedResponse.status, 403, 'prefix sibling must be BLOCKED_SCOPE');
        assert.equal(escapedResponse.code, 'BLOCKED_SCOPE');

        // 3. Database is clean: no rows persisted
        const nodes = await db.all("SELECT count(*)::int AS cnt FROM graph_node WHERE project = $1", [project]);
        assert.equal(nodes[0].cnt, 0, 'No nodes should be written on toolchain failure');
    } finally {
        await pg.cleanup();
    }
});
