import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestPgGraph } from '../../helpers/test-pg-graph.mjs';
import { startGraphApi, postGraph } from './_app.mjs';

const PROJECT = 'project-rebuild';
const BUILD = 'build-rebuild';
const TOKEN = 'graph-acceptance-token';
const FIXTURE = fileURLToPath(new URL('../../fixtures/csharp/SimpleMonolith/SimpleMonolith.csproj', import.meta.url));

async function counts(db) {
    const nodes = await db.get(
        'SELECT count(*)::int AS total, count(DISTINCT node_id)::int AS distinct_ids FROM graph_node WHERE project = ? AND build_id = ?',
        [PROJECT, BUILD]
    );
    const edges = await db.get(
        'SELECT count(*)::int AS total, count(DISTINCT edge_id)::int AS distinct_ids FROM graph_edge WHERE project = ? AND build_id = ?',
        [PROJECT, BUILD]
    );
    return {
        nodes: Number(nodes.total),
        distinctNodes: Number(nodes.distinct_ids),
        edges: Number(edges.total),
        distinctEdges: Number(edges.distinct_ids),
    };
}

test('SCN-GRAPH-12 · AC-GRAPH-03-02 — rebuild cùng build_id', { timeout: 180000 }, async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;
    let api;
    try {
        api = await startGraphApi({ db, project: PROJECT, token: TOKEN });

        const indexRes = await postGraph(api.baseUrl, '/v1/graph/index', {
            build_id: BUILD,
            source: { kind: 'roslyn', solution_path: FIXTURE },
        }, { token: TOKEN });
        assert.equal(indexRes.status, 202, `index must be accepted: ${await indexRes.text()}`);

        const first = await counts(db);
        assert.ok(first.nodes > 0, 'index must persist nodes');
        assert.ok(first.edges > 0, 'index must persist edges');
        assert.equal(first.nodes, first.distinctNodes, 'node_id must be unique per build');
        assert.equal(first.edges, first.distinctEdges, 'edge_id must be unique per build');

        // API-28 replay: same build_id + same source bytes is not a second extraction.
        const replayRes = await postGraph(api.baseUrl, '/v1/graph/index', {
            build_id: BUILD,
            source: { kind: 'roslyn', solution_path: FIXTURE },
        }, { token: TOKEN });
        assert.equal(replayRes.status, 202);
        const replay = await replayRes.json();
        assert.equal(replay.replayed, true, 'same source_hash must replay, not re-index');

        // API-28 conflict: the same build_id with different source bytes is refused, not overwritten.
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-graph-conflict-'));
        try {
            const fixtureDir = path.dirname(FIXTURE);
            fs.cpSync(fixtureDir, tempRoot, { recursive: true });
            const tempSolution = path.join(tempRoot, path.basename(FIXTURE));
            const firstCopy = await postGraph(api.baseUrl, '/v1/graph/index', {
                build_id: 'build-conflict',
                source: { kind: 'roslyn', solution_path: tempSolution },
            }, { token: TOKEN });
            assert.equal(firstCopy.status, 202, `temp fixture must index: ${await firstCopy.text()}`);

            fs.appendFileSync(tempSolution, '\n<!-- different source bytes -->\n');
            const conflictRes = await postGraph(api.baseUrl, '/v1/graph/index', {
                build_id: 'build-conflict',
                source: { kind: 'roslyn', solution_path: tempSolution },
            }, { token: TOKEN });
            const conflictText = await conflictRes.text();
            assert.equal(conflictRes.status, 409, `different source for same build_id must conflict: ${conflictText}`);
            assert.equal(JSON.parse(conflictText).code, 'CONFLICT');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }

        // API-29: replacing the same build twice must keep exactly the same rows.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const rebuildRes = await postGraph(api.baseUrl, '/v1/graph/rebuild', {
                build_id: BUILD,
            }, { token: TOKEN });
            assert.equal(rebuildRes.status, 202, `rebuild ${attempt} must be accepted: ${await rebuildRes.text()}`);

            const after = await counts(db);
            assert.deepEqual(after, first, `rebuild ${attempt} must be idempotent (same node/edge count, no duplicates)`);
        }
    } finally {
        if (api) await api.close();
        await pg.cleanup();
    }
});
