// W1-1 — the graph schema and the four invariants its packet promises.
//
// These run against a real Postgres because three of the four invariants do not exist elsewhere:
// row-level security, a trigger that refuses UPDATE, and CHECK constraints. Testing them against a
// mock would test the mock.
//
// The repo has no Postgres client and developer machines may have no psql, so the statement is sent
// through the container that already runs Postgres (ESO_TEST_PG_CONTAINER + ESO_TEST_PG_DB), using the
// psql that is inside the image. When neither a local psql nor a container is configured, the test is
// skipped rather than silently passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const SQL = readFileSync(join(ROOT, 'packages/harness-observe-server/db/pg/001_graph.sql'), 'utf8');
const CONTAINER = process.env.ESO_TEST_PG_CONTAINER;
const DB = process.env.ESO_TEST_PG_DB;
const PGUSER = process.env.ESO_TEST_PG_USER ?? 'postgres';

function psql(sql, { allowFailure = false } = {}) {
    const args = CONTAINER
        ? ['exec', '-i', CONTAINER, 'psql', '-U', PGUSER, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-']
        : ['psql', process.env.ESO_TEST_PG, '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-'];
    try {
        return execFileSync(CONTAINER ? 'docker' : 'psql', args, {
            encoding: 'utf8',
            input: sql,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        if (allowFailure) return `${err.stderr ?? ''}`;
        throw new Error(`sql failed: ${err.stderr ?? err.message}`);
    }
}

const skip = CONTAINER || process.env.ESO_TEST_PG ? false : 'no test database configured';

test('W1-1: the migration applies twice without error (idempotent)', { skip }, () => {
    psql(SQL);
    psql(SQL);
    const n = psql(`SELECT count(*) FROM information_schema.tables
                    WHERE table_name IN ('manifest_entry','graph_node','graph_edge','source_claim','completeness')`);
    assert.equal(Number(n.trim()), 5);
});

test('W1-1: source_claim refuses UPDATE and DELETE (BR-06)', { skip }, () => {
    // The table refuses DELETE by design (BR-06), so cleanup cannot use it. Truncate is not
    // allowed either — rebuild the table via the migration, which is idempotent.
    psql(`DROP TABLE IF EXISTS source_claim CASCADE`);
    psql(SQL);
    psql(`INSERT INTO source_claim (project,build_id,edge_src,edge_kind,edge_dst,source_kind,claim)
          VALUES ('p1','b1','A','calls','B','roslyn','x')`);
    const upd = psql(`UPDATE source_claim SET claim='tampered' WHERE project='p1'`, { allowFailure: true });
    const del = psql(`DELETE FROM source_claim WHERE project='p1'`, { allowFailure: true });
    assert.match(upd, /append-only/i, 'UPDATE must be refused');
    assert.match(del, /append-only/i, 'DELETE must be refused');
    assert.equal(psql(`SELECT count(*) FROM source_claim`).trim(), '1');
});

test('W1-1: completeness cannot be null or out of range, node path cannot be empty', { skip }, () => {
    const nullValue = psql(
        `INSERT INTO completeness (project,build_id,question,per_kind,value)
         VALUES ('p1','b1','Qn','{}',NULL)`, { allowFailure: true });
    assert.match(nullValue, /not-null/i);

    const outOfRange = psql(
        `INSERT INTO completeness (project,build_id,question,per_kind,value)
         VALUES ('p1','b1','Qr','{}',1.5)`, { allowFailure: true });
    assert.match(outOfRange, /check constraint/i);

    const emptyPath = psql(
        `INSERT INTO graph_node (project,build_id,kind,logical_id,path)
         VALUES ('p1','b1','class','E','')`, { allowFailure: true });
    assert.match(emptyPath, /check constraint/i);
});

test('W1-1: edge kind is a closed set', { skip }, () => {
    const bad = psql(
        `INSERT INTO graph_edge (project,build_id,src,kind,dst) VALUES ('p1','b1','A','invented','B')`,
        { allowFailure: true });
    assert.match(bad, /check constraint/i);
});

test('W1-1: a non-superuser sees only its own project, and cannot write into another', { skip }, () => {
    psql(`
        -- The role may already exist with grants attached, and DROP ROLE refuses while any exist.
        -- Creating only when absent and re-granting is idempotent; GRANT is a no-op if already held.
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eso_app_test') THEN
                CREATE ROLE eso_app_test LOGIN NOSUPERUSER NOBYPASSRLS;
            END IF;
        END $$;
        GRANT USAGE ON SCHEMA public TO eso_app_test;
        GRANT SELECT, INSERT ON graph_node, source_claim TO eso_app_test;
        GRANT USAGE, SELECT ON SEQUENCE source_claim_id_seq TO eso_app_test;
        DELETE FROM graph_node;
        INSERT INTO graph_node (project,build_id,kind,logical_id,path) VALUES
          ('p1','b1','class','A','a.cs'), ('p2','b1','class','B','b.cs');
    `);

    // One session per assertion: SET ROLE does not survive between psql invocations, and a role
    // that is not current sees everything as the owner.
    const counts = psql(`
        SET ROLE eso_app_test;
        SET eso.project='p1'; SELECT count(*) FROM graph_node;
        SET eso.project='p3'; SELECT count(*) FROM graph_node;
    `).trim().split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
    assert.equal(counts[0], '1', 'p1 sees exactly its own row');
    assert.equal(counts[1], '0', 'an unknown project sees nothing');

    const crossWrite = psql(
        `SET ROLE eso_app_test; SET eso.project='p1';
         INSERT INTO graph_node (project,build_id,kind,logical_id,path) VALUES ('p2','b1','class','X','x.cs');`,
        { allowFailure: true });
    assert.match(crossWrite, /row-level security/i, 'writing into another project must be refused');
});
