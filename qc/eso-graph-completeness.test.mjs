import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCompleteness, QUESTION_KIND_MAP } from '../eso/graph/src/index.mjs';
import { createTestPgGraph } from './helpers/test-pg-graph.mjs';

test('SCN-ARCH-02 (AC-ARCH-01-02 & BR-05): Incomplete graph returns unknown with coverage ratio, never absent', () => {
    // 1. Partial coverage on Q1
    const partialCoverageQ1 = {
        file: { covered: 10, total: 10 },    // 100%
        class: { covered: 8, total: 10 },    // 80%
        method: { covered: 3, total: 10 }    // 30%
    };

    const resQ1 = calculateCompleteness('Q1', partialCoverageQ1);
    // completeness(Q) = min{coverage(k)} across K(Q)
    assert.equal(resQ1.value, 0.3);
    assert.equal(resQ1.coverage, 0.3);
    assert.equal(resQ1.status, 'unknown');
    assert.notEqual(resQ1.status, 'absent'); // BR-05 enforcement: unknown != absent

    // 2. Completely empty coverage on Q2
    const emptyQ2 = calculateCompleteness('Q2', {});
    assert.equal(typeof emptyQ2.value, 'number');
    assert.equal(emptyQ2.value, 0);
    assert.equal(emptyQ2.status, 'unknown');
    assert.notEqual(emptyQ2.status, 'absent');

    // 3. Question kind mapping verification
    assert.deepEqual(QUESTION_KIND_MAP.Q1, ['file', 'class', 'method']);
    assert.deepEqual(QUESTION_KIND_MAP.Q2, ['table', 'entity', 'column']);
    assert.deepEqual(QUESTION_KIND_MAP.Q3, ['module', 'package']);
});

test('BR-06: source_claim is append-only, UPDATE/DELETE rejected by DB triggers on PostgreSQL (D-92 / D-93)', async () => {
    const pg = await createTestPgGraph();
    const { db } = pg;

    try {
        await db.run(
            `INSERT INTO graph_node (project, build_id, node_id, kind, node_key, path)
             VALUES ('proj-1', 'b1', 'n1', 'module', 'a.ts', 'src/a.ts')`
        );
        await db.run(
            `INSERT INTO source_claim (project, build_id, edge_id, seq, source_kind, claim)
             VALUES ('proj-1', 'b1', 'edge-1', 1, 'roslyn', 'claim test')`
        );

        // UPDATE must fail with BR-06 error
        await assert.rejects(async () => {
            await db.run("UPDATE source_claim SET claim = 'hacked' WHERE edge_id = 'edge-1' AND seq = 1");
        }, /(BR-06|APPEND_ONLY)/);

        // DELETE must fail with BR-06 error
        await assert.rejects(async () => {
            await db.run("DELETE FROM source_claim WHERE edge_id = 'edge-1' AND seq = 1");
        }, /(BR-06|APPEND_ONLY)/);
    } finally {
        await pg.cleanup();
    }
});
