import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { initSchema, calculateCompleteness, QUESTION_KIND_MAP } from '../eso/graph/src/index.mjs';

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

test('BR-06: source_claim is append-only, UPDATE/DELETE rejected by DB triggers', () => {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
    };

    initSchema(db);

    db.run(
        `INSERT INTO graph_node (id, project, kind, name, path, created_at, updated_at)
         VALUES ('n1', 'proj-1', 'file', 'a.ts', 'src/a.ts', '2026-11-03', '2026-11-03')`
    );
    db.run(
        `INSERT INTO source_claim (id, project, node_id, claim_type, claim_payload, created_at)
         VALUES ('sc-1', 'proj-1', 'n1', 'ast_call', '{}', '2026-11-03')`
    );

    // UPDATE must fail with BR-06 error
    assert.throws(() => {
        db.run("UPDATE source_claim SET claim_type = 'hacked' WHERE id = 'sc-1'");
    }, /BR-06/);

    // DELETE must fail with BR-06 error
    assert.throws(() => {
        db.run("DELETE FROM source_claim WHERE id = 'sc-1'");
    }, /BR-06/);
});
