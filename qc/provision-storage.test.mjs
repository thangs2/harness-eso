// RED — ESO-484 / BIP-1_8 (slice 1.8): provision graph storage at `init profile`.
//
// These seven tests are the Stage 7 negative control for `sdlc/10.test/66..69` (T1–T5) and for the
// ESO-484 rework that sent the slice back to `In Progress` (T6, T7). They are written BEFORE the
// behaviour exists, so every one of them must fail on an assertion — never on a missing import, a
// syntax error or a fixture problem. The contract they pin (and the builder must satisfy) lives in
// the packets, §6:
//
//   packages/harness-foundation/src/graph-storage.mjs
//     planGraphStorage({ consumerId, config, adminUrl }) -> { storage: { graph }, config }
//     applyGraphStorage({ consumerId, connect })         -> { schemaVersion, project, applied }
//
//   provision.sh <consumer> --plan   prints the `storage.graph` block, opens no DB connection
//   be-demo.sh --consumer=<id>       refuses an unprovisioned consumer, before running the demo
//   verify-consumer.sh <consumer>    fails with a reason when `storage.graph` points nowhere
//
// D-105: one database + `project` column + RLS FORCE; the config carries `storage.graph` and never a
// password; the admin URL is provision-time only. D-47: a second run creates nothing new.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_STORAGE = path.join(ESO_ROOT, 'packages/harness-foundation/src/graph-storage.mjs');

// A password no legitimate plan may echo or store. `SUPERSECRET` is deliberately distinctive so a
// `assert.doesNotMatch` cannot pass by accident.
const ADMIN_PASSWORD = 'SUPERSECRET-admin-password';
const CORE_TABLES = ['graph_node', 'graph_edge', 'source_claim', 'completeness'];

function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeWorkspace(stateDir, { id, root, port }) {
    fs.writeFileSync(
        path.join(stateDir, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: id,
            projects: [{ id, displayName: id, root, rootHost: root, observe: { port } }],
        }),
    );
}

/** Run a real entrypoint from the repo root, with an isolated product state dir. */
function runScript(script, args, env = {}) {
    const res = spawnSync(path.join(ESO_ROOT, script), args, {
        cwd: ESO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
            ...process.env,
            // Never let the operator's real registry (or a stray admin URL) decide the outcome.
            HARNESS_PRODUCT_STATE_DIR: '',
            HARNESS_GRAPH_ADMIN_URL: '',
            ESO_DEMO_DB_URL: '',
            ...env,
        },
    });
    const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
    return {
        status: res.status,
        signal: res.signal ?? null,
        out: `${strip(res.stdout)}${strip(res.stderr)}`,
        error: res.error,
    };
}

/**
 * Load the module the builder must create. A missing file is a *contract* failure, not a test
 * crash: the assertion then says which export is absent, which is what R2 describes.
 */
async function graphStorageModule() {
    try {
        return await import(pathToFileURL(GRAPH_STORAGE).href);
    } catch (err) {
        return { __importError: err };
    }
}

/**
 * A TCP listener that counts connections. `--plan` promises it never opens the database, so the way
 * to prove that is to point the admin URL at a socket that can see every attempt.
 */
async function connectionProbe(t) {
    const server = net.createServer((socket) => {
        server.connections += 1;
        socket.destroy();
    });
    server.connections = 0;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { port: server.address().port, count: () => server.connections };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// A tiny PostgreSQL stand-in: it only needs to be honest about the two things D-47 protects.
//
//   * DDL is idempotent only when it says `IF NOT EXISTS` / `DROP ... IF EXISTS` / `OR REPLACE`.
//     A second run of non-idempotent DDL is recorded as a duplicate instead of being forgiven.
//   * `INSERT INTO project ... ON CONFLICT (project)` is an upsert; a plain INSERT creates a second
//     row, which is exactly the defect T2 pins.
//
// It also records RLS (`ENABLE`/`FORCE`), policies and triggers so T2 can assert the isolation
// surface exists, not merely that *some* SQL ran.
// ---------------------------------------------------------------------------------------------
function createFakeGraphDb() {
    const state = {
        tables: new Set(),
        indexes: new Set(),
        policies: new Map(), // name -> table
        triggers: new Map(), // name -> table
        functions: new Set(),
        rls: new Set(), // `${table}:enable` / `${table}:force`
        constraints: new Set(),
        projectRows: [],
        duplicateDdl: [],
        insertIntoMissingTable: [],
        // Every statement in arrival order — T6 needs the *order* (schema, then search_path, then
        // tables/rows), which a set of created objects cannot express.
        statements: [],
        connections: 0,
        active: 0,
        maxActive: 0,
    };

    function duplicate(kind, name) {
        state.duplicateDdl.push(`${kind} ${name}`);
    }

    function insertProject(params, sql) {
        if (!state.tables.has('project')) state.insertIntoMissingTable.push('project');
        const inline = /values\s*\(\s*'([^']+)'/i.exec(sql);
        const id = String(params?.[0] ?? inline?.[1] ?? '');
        if (/on\s+conflict/i.test(sql)) {
            if (!state.projectRows.includes(id)) state.projectRows.push(id);
        } else {
            state.projectRows.push(id);
        }
    }

    /**
     * Comments are removed BEFORE splitting on `;`. A comment can contain a semicolon itself
     * (`-- 2. graph_edge: quan hệ có hướng; KHÔNG có cột nguồn`), and splitting first turns the
     * tail of that comment into an unrecognised "statement" that swallows the next CREATE TABLE.
     */
    const stripComments = (sql) =>
        String(sql)
            .split('\n')
            .filter((line) => !/^\s*--/.test(line))
            .join('\n');

    function statement(raw, params = []) {
        const sql = String(raw).replace(/\s+/g, ' ').trim();
        if (!sql) return;
        state.statements.push(sql);
        let m;

        if ((m = /^DROP TRIGGER IF EXISTS ([A-Za-z_]\w*) ON ([A-Za-z_]\w*)/i.exec(sql))) {
            state.triggers.delete(m[1].toLowerCase());
            return;
        }
        if ((m = /^DROP POLICY IF EXISTS ([A-Za-z_]\w*) ON ([A-Za-z_]\w*)/i.exec(sql))) {
            state.policies.delete(m[1].toLowerCase());
            return;
        }
        if ((m = /^CREATE TRIGGER ([A-Za-z_]\w*) ON ([A-Za-z_]\w*)/i.exec(sql)) || (m = /^CREATE TRIGGER ([A-Za-z_]\w*)[\s\S]*?\bON\s+([A-Za-z_]\w*)/i.exec(sql))) {
            const name = m[1].toLowerCase();
            if (state.triggers.has(name)) duplicate('trigger', name);
            state.triggers.set(name, m[2].toLowerCase());
            return;
        }
        if ((m = /^CREATE POLICY ([A-Za-z_]\w*) ON ([A-Za-z_]\w*)/i.exec(sql))) {
            const name = m[1].toLowerCase();
            if (state.policies.has(name)) duplicate('policy', name);
            state.policies.set(name, m[2].toLowerCase());
            return;
        }
        if ((m = /^CREATE (?:OR REPLACE )?FUNCTION ([A-Za-z_]\w*)/i.exec(sql))) {
            state.functions.add(m[1].toLowerCase());
            return;
        }
        if ((m = /^CREATE (?:UNIQUE )?INDEX (IF NOT EXISTS )?([A-Za-z_]\w*)/i.exec(sql))) {
            const name = m[2].toLowerCase();
            if (state.indexes.has(name) && !m[1]) duplicate('index', name);
            state.indexes.add(name);
            return;
        }
        if ((m = /^CREATE TABLE (IF NOT EXISTS )?([A-Za-z_]\w*)/i.exec(sql))) {
            const name = m[2].toLowerCase();
            if (state.tables.has(name) && !m[1]) duplicate('table', name);
            state.tables.add(name);
            return;
        }
        if ((m = /^ALTER TABLE ([A-Za-z_]\w*) (ENABLE|FORCE|DISABLE|NO FORCE) ROW LEVEL SECURITY/i.exec(sql))) {
            state.rls.add(`${m[1].toLowerCase()}:${m[2].toLowerCase()}`);
            return;
        }
        if ((m = /^ALTER TABLE ([A-Za-z_]\w*) (?:DROP|ADD) CONSTRAINT (?:IF EXISTS )?([A-Za-z_]\w*)/i.exec(sql))) {
            const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
            if (/DROP/i.test(sql)) state.constraints.delete(key);
            else state.constraints.add(key);
            return;
        }
        if ((m = /^(?:REVOKE|GRANT)\b[\s\S]*?\bON\s+(?:TABLE\s+)?([A-Za-z_]\w*)/i.exec(sql))) {
            // Append-only enforcement: the revoke itself is not modelled, only that it happened.
            state.rls.add(`${m[1].toLowerCase()}:revoke`);
            return;
        }
        if ((m = /^INSERT INTO ([A-Za-z_]\w*)/i.exec(sql))) {
            const table = m[1].toLowerCase();
            if (table === 'project') return insertProject(params, sql);
            if (!state.tables.has(table)) state.insertIntoMissingTable.push(table);
            return;
        }
        // BEGIN/COMMIT/SET/SELECT/CREATE SCHEMA/ALTER ... ADD COLUMN: accepted, not modelled.
    }

    const client = {
        async exec(sql) {
            for (const part of stripComments(sql).split(';')) statement(part);
            return { rows: [], rowCount: 0 };
        },
        async query(sql, params = []) {
            statement(stripComments(sql), params);
            return { rows: [], rowCount: 0 };
        },
        async unsafe(sql, params = []) {
            statement(stripComments(sql), params);
            return { rows: [], rowCount: 0 };
        },
        async close() {
            if (state.active > 0) state.active -= 1;
        },
        async end() {
            if (state.active > 0) state.active -= 1;
        },
        release() {
            if (state.active > 0) state.active -= 1;
        },
    };

    return {
        state,
        connect: async () => {
            state.connections += 1;
            state.active += 1;
            state.maxActive = Math.max(state.maxActive, state.active);
            return client;
        },
    };
}

/**
 * Write an executable `bun` earlier on PATH. If `be-demo.sh` reaches the demo runner it calls this,
 * which is the observable difference between "checked the consumer" and "ran with an env URL".
 */
function fakeBun(t, dir) {
    const probe = path.join(dir, 'bun-invoked');
    fs.writeFileSync(path.join(dir, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${probe}"\nexit 0\n`);
    fs.chmodSync(path.join(dir, 'bun'), 0o755);
    t.after(() => fs.rmSync(probe, { force: true }));
    return {
        dir,
        invoked: () => fs.existsSync(probe),
        args: () => (fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim() : ''),
    };
}

// ---------------------------------------------------------------------------------------------
// T1 (BIP §7) — `provision.sh <consumer> --plan` prints `storage.graph`, opens no connection.
// ---------------------------------------------------------------------------------------------
test('provision --plan is read-only and prints storage.graph', async (t) => {
    const state = tempDir(t, 'harness-graph-plan-state-');
    const consumer = tempDir(t, 'harness-graph-plan-consumer-');
    writeWorkspace(state, { id: 'alpha', root: consumer, port: 9421 });
    const probe = await connectionProbe(t);
    const adminUrl = `postgres://eso:${ADMIN_PASSWORD}@127.0.0.1:${probe.port}/eso_alpha?sslmode=disable`;

    const r = runScript('provision.sh', ['alpha', '--plan'], {
        HARNESS_PRODUCT_STATE_DIR: state,
        HARNESS_GRAPH_ADMIN_URL: adminUrl,
    });
    assert.equal(r.status, 0, `--plan must succeed without a database; exited ${r.status}:\n${r.out.slice(0, 800)}`);

    assert.match(
        r.out,
        /storage\.graph/,
        `--plan must print the storage.graph block it would write (D-105 #4); got:\n${r.out.slice(0, 1000)}`,
    );
    for (const [key, value] of [
        ['host', '127.0.0.1'],
        ['port', String(probe.port)],
        ['database', 'eso_alpha'],
        ['schema', 'eso'],
        ['ssl', 'false'],
        ['isolation', 'shared'],
    ]) {
        assert.match(
            r.out,
            new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']?${value}`, 'i'),
            `storage.graph.${key} must be ${value}; got:\n${r.out.slice(0, 1000)}`,
        );
    }
    assert.doesNotMatch(r.out, new RegExp(ADMIN_PASSWORD), '--plan echoed the admin password (D-105: config has no secret)');

    // Read-only means two things: no file appears under the consumer, and no socket is opened.
    assert.deepEqual(fs.readdirSync(consumer), [], '--plan wrote into the consumer (it must write nothing)');
    await sleep(100);
    assert.equal(probe.count(), 0, `--plan opened ${probe.count()} connection(s) to the graph database (it must open none)`);
});

// ---------------------------------------------------------------------------------------------
// T2 (BIP §7) — apply twice: one schema/version, one `project` row, one connection per run.
// ---------------------------------------------------------------------------------------------
test('apply is idempotent — two runs, one schema, one project row', async (t) => {
    const mod = await graphStorageModule();
    assert.equal(
        typeof mod.applyGraphStorage,
        'function',
        `packages/harness-foundation/src/graph-storage.mjs must export applyGraphStorage({ consumerId, connect }) — ${
            mod.__importError ? mod.__importError.message : 'export missing'
        }`,
    );

    const db = createFakeGraphDb();
    const first = await mod.applyGraphStorage({ consumerId: 'alpha', connect: db.connect });
    const second = await mod.applyGraphStorage({ consumerId: 'alpha', connect: db.connect });

    assert.equal(
        db.state.connections,
        2,
        'each apply must open exactly one connection for schema + register (D-105 #4), not one per statement',
    );
    assert.equal(db.state.maxActive, 1, 'apply must not hold two connections open at once');
    assert.deepEqual(db.state.duplicateDdl, [], 'a second apply re-created an object without IF NOT EXISTS (D-47)');
    assert.deepEqual(db.state.insertIntoMissingTable, [], 'apply inserted into a table no DDL created');

    for (const table of CORE_TABLES) {
        assert.ok(db.state.tables.has(table), `apply must create ${table} (BIP §5)`);
        assert.ok(db.state.rls.has(`${table}:enable`), `${table} must ENABLE ROW LEVEL SECURITY (D-105 #1)`);
        assert.ok(db.state.rls.has(`${table}:force`), `${table} must FORCE ROW LEVEL SECURITY (D-105 #1)`);
        assert.ok(
            [...db.state.policies.values()].includes(table),
            `${table} must carry a project-scoped policy (D-105 #1)`,
        );
    }
    assert.ok(
        [...db.state.triggers.values()].includes('source_claim'),
        'source_claim must carry the append-only trigger (BR-06)',
    );

    assert.equal(db.state.projectRows.length, 1, `two applies made ${db.state.projectRows.length} project rows (must be 1)`);
    assert.deepEqual(db.state.projectRows, ['alpha']);
    assert.ok(first.schemaVersion, 'apply must report the schema version it ensured');
    assert.equal(second.schemaVersion, first.schemaVersion, 'a second apply changed the schema version');
});

// ---------------------------------------------------------------------------------------------
// T3 (BIP §7) — config gains storage.graph, has no password, keeps every unrelated key.
// ---------------------------------------------------------------------------------------------
test('config gets storage.graph without any password', async (t) => {
    const mod = await graphStorageModule();
    assert.equal(
        typeof mod.planGraphStorage,
        'function',
        `packages/harness-foundation/src/graph-storage.mjs must export planGraphStorage({ consumerId, config, adminUrl }) — ${
            mod.__importError ? mod.__importError.message : 'export missing'
        }`,
    );

    const config = {
        version: 1,
        project: { id: 'alpha', displayName: 'alpha' },
        storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        server: { host: '127.0.0.1', port: 9422 },
        operator: { tuning: { keep: 'this key' } },
    };
    const before = structuredClone(config);
    const plan = await mod.planGraphStorage({
        consumerId: 'alpha',
        config,
        adminUrl: `postgres://eso:${ADMIN_PASSWORD}@127.0.0.1:54329/eso_alpha?sslmode=disable`,
    });

    assert.deepEqual(config, before, 'planGraphStorage must not mutate the config it is handed (a plan is read-only)');
    assert.ok(plan && plan.storage && plan.storage.graph, 'plan.storage.graph is missing');
    assert.deepEqual(
        plan.storage.graph,
        { host: '127.0.0.1', port: 54329, database: 'eso_alpha', schema: 'eso', ssl: false, isolation: 'shared' },
        'storage.graph must be exactly { host, port, database, schema, ssl, isolation } (BIP §3)',
    );
    assert.equal(plan.config.server.port, 9422, 'an unrelated config key was dropped');
    assert.deepEqual(plan.config.operator, { tuning: { keep: 'this key' } }, 'operator keys must survive the merge');
    assert.deepEqual(plan.config.storage.sqlite, { path: '.harness/harness.db' }, 'the old storage block must survive');

    const text = JSON.stringify(plan.config);
    assert.ok(!text.includes(ADMIN_PASSWORD), 'the admin password was written into the consumer config (D-105 #4)');
    assert.doesNotMatch(text, /"(password|passwd|pwd)"\s*:/i, 'the config grew a password field');
    assert.ok(!text.includes('postgres://'), 'a credential-bearing URL must not be stored in the config (D-105 #4)');
});

// ---------------------------------------------------------------------------------------------
// T4 (BIP §7) — `be-demo.sh --consumer=<id>` stops before the demo when storage is unprovisioned.
// ---------------------------------------------------------------------------------------------
test('be-demo.sh requires a provisioned consumer', (t) => {
    const state = tempDir(t, 'harness-graph-demo-state-');
    const consumer = tempDir(t, 'harness-graph-demo-consumer-');
    writeWorkspace(state, { id: 'alpha', root: consumer, port: 9423 });
    const bun = fakeBun(t, tempDir(t, 'harness-graph-demo-bin-'));

    const r = runScript('sdlc/11.delivery/be-demo.sh', ['--consumer=alpha'], {
        HARNESS_PRODUCT_STATE_DIR: state,
        // The old path: a demo that reads an env URL instead of the consumer's config. D-105 #6
        // says the normal path must not fall back to it.
        ESO_DEMO_DB_URL: `postgres://eso:${ADMIN_PASSWORD}@127.0.0.1:1/eso_demo`,
        PATH: `${bun.dir}:${process.env.PATH}`,
    });

    assert.notEqual(
        r.status,
        0,
        `be-demo.sh ran for an unprovisioned consumer (exit ${r.status}); runner args: ${bun.args() || '(none)'}\n${r.out.slice(0, 600)}`,
    );
    assert.equal(bun.invoked(), false, `be-demo.sh invoked the demo runner before checking provisioning: ${bun.args()}`);
    assert.match(
        r.out,
        /\.\/provision\.sh\s+alpha/,
        `the refusal must name the command that fixes it (./provision.sh alpha); got:\n${r.out.slice(0, 800)}`,
    );
    assert.ok(!r.out.includes(ADMIN_PASSWORD), 'be-demo.sh echoed the env DB password');
});

// ---------------------------------------------------------------------------------------------
// T5 (BIP §7) — `verify-consumer.sh` detects a `storage.graph` that no database answers.
// ---------------------------------------------------------------------------------------------
test('verify-consumer.sh fails when the graph database is missing', (t) => {
    const state = tempDir(t, 'harness-graph-verify-state-');
    const consumer = tempDir(t, 'harness-graph-verify-consumer-');
    writeWorkspace(state, { id: 'alpha', root: consumer, port: 9424 });
    fs.writeFileSync(
        path.join(consumer, 'harness.config.json'),
        JSON.stringify({
            version: 1,
            project: { id: 'alpha', displayName: 'alpha' },
            storage: {
                driver: 'sqlite',
                sqlite: { path: '.harness/harness.db' },
                graph: {
                    host: '127.0.0.1',
                    port: 1,
                    database: 'eso_alpha_missing',
                    schema: 'eso',
                    ssl: false,
                    isolation: 'shared',
                },
            },
            server: { host: '127.0.0.1', port: 9424 },
        }),
    );

    const r = runScript('verify-consumer.sh', ['alpha'], {
        HARNESS_PRODUCT_STATE_DIR: state,
        PGCONNECT_TIMEOUT: '2',
    });

    assert.equal(
        r.status,
        1,
        `a consumer whose storage.graph points at no database must fail verification (exit ${r.status}):\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /storage\.graph/,
        `the failure must name storage.graph as the missing piece; got:\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /eso_alpha_missing/,
        `the failure must name the database it could not open; got:\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /\.\/provision\.sh\s+alpha/,
        `the failure must name the command that fixes it (./provision.sh alpha); got:\n${r.out.slice(0, 800)}`,
    );
});

// ---------------------------------------------------------------------------------------------
// T6 (ESO-484 rework) — `applyGraphStorage` must create the configured schema and move the session
// onto it before its first `CREATE TABLE`. The Stage 8 apply did neither: PostgreSQL accepted the
// DDL in `public`, the config said `schema: "eso"`, and the app's `search_path=eso` then failed with
// `relation "graph_node" does not exist`. A fake connection records every statement in order, which
// is the only way to pin "before any table" rather than "somewhere in the run".
// ---------------------------------------------------------------------------------------------
test('apply creates the configured schema before any table, and sets search_path', async () => {
    const mod = await graphStorageModule();
    assert.equal(
        typeof mod.applyGraphStorage,
        'function',
        `packages/harness-foundation/src/graph-storage.mjs must export applyGraphStorage({ consumerId, connect }) — ${
            mod.__importError ? mod.__importError.message : 'export missing'
        }`,
    );

    const db = createFakeGraphDb();
    await mod.applyGraphStorage({ consumerId: 'alpha', connect: db.connect });

    const statements = db.state.statements;
    const preview = statements.slice(0, 6).map((sql) => sql.slice(0, 90)).join(' | ') || '(no SQL ran)';
    const firstTable = statements.findIndex((sql) => /^CREATE TABLE\b/i.test(sql));
    const createSchema = statements.findIndex((sql) => /^CREATE SCHEMA IF NOT EXISTS\s+"?eso"?(?:\s|$)/i.test(sql));
    const setSearchPath = statements.findIndex(
        (sql) => /^SET\s+(?:LOCAL\s+)?search_path\b/i.test(sql) && /\beso\b/i.test(sql),
    );
    const insertProject = statements.findIndex((sql) => /^INSERT INTO\s+(?:"?eso"?\.)?"?project"?/i.test(sql));

    assert.ok(firstTable >= 0, `apply ran no CREATE TABLE at all; got: ${preview}`);
    assert.ok(
        createSchema >= 0,
        `apply must create the configured schema (CREATE SCHEMA IF NOT EXISTS "eso") before any table; ` +
            `without it the DDL lands in public while storage.graph.schema says eso (D-105 #4). got: ${preview}`,
    );
    assert.ok(
        createSchema < firstTable,
        `CREATE SCHEMA must run before the first CREATE TABLE (schema at #${createSchema}, table at #${firstTable}); got: ${preview}`,
    );
    assert.ok(
        setSearchPath >= 0,
        `apply must SET [LOCAL] search_path TO eso before creating tables (D-105 #4); got: ${preview}`,
    );
    assert.ok(
        setSearchPath < firstTable,
        `SET search_path must run before the first CREATE TABLE (search_path at #${setSearchPath}, table at #${firstTable}); got: ${preview}`,
    );
    assert.ok(insertProject >= 0, `apply must register the project with INSERT INTO project; got: ${preview}`);
    assert.ok(
        insertProject > setSearchPath,
        `INSERT INTO project must run after SET search_path so the row is written into eso ` +
            `(insert at #${insertProject}, search_path at #${setSearchPath}); got: ${preview}`,
    );
});

// ---------------------------------------------------------------------------------------------
// T7 (ESO-484 rework) — `verify-consumer.sh` must prove the graph *schema* exists, not merely that a
// socket accepts. T5 only proves the "nothing is listening" case; a database that is up but has no
// `eso` schema (the Stage 8 state) passed T5 and shipped green.
//
// The fixture is a PostgreSQL wire-protocol stand-in, not a real server: it completes the handshake,
// answers a plain `SELECT 1` health probe, and rejects every statement that touches a table with the
// error a real PostgreSQL returns for a missing schema. So the failure cannot be blamed on an
// unreachable socket — the only honest verdict left is "schema missing/stale", named with the fix.
// ---------------------------------------------------------------------------------------------
test('verify-consumer.sh fails when the graph schema is missing or stale', async (t) => {
    const state = tempDir(t, 'harness-graph-schema-state-');
    const consumer = tempDir(t, 'harness-graph-schema-consumer-');
    writeWorkspace(state, { id: 'alpha', root: consumer, port: 9425 });
    const pg = await schemaMissingPostgres(t);

    fs.writeFileSync(
        path.join(consumer, 'harness.config.json'),
        JSON.stringify({
            version: 1,
            project: { id: 'alpha', displayName: 'alpha' },
            storage: {
                driver: 'sqlite',
                sqlite: { path: '.harness/harness.db' },
                graph: {
                    host: '127.0.0.1',
                    port: pg.port,
                    database: 'eso_alpha_unprovisioned',
                    schema: 'eso',
                    ssl: false,
                    isolation: 'shared',
                },
            },
            server: { host: '127.0.0.1', port: 9425 },
        }),
    );

    const r = runScript('verify-consumer.sh', ['alpha'], {
        HARNESS_PRODUCT_STATE_DIR: state,
        PGCONNECT_TIMEOUT: '2',
    });

    assert.equal(
        r.status,
        1,
        `a reachable database without the configured graph schema is an unprovisioned consumer ` +
            `(exit ${r.status}):\n${r.out.slice(0, 800)}`,
    );
    // The schema verdict has to be about `storage.graph`, not a maturity check that happens to use
    // the words "schema" or "eso": a reachable-but-empty database already reports both somewhere in
    // the 27-line maturity report, and matching that would be the same "green because not looking"
    // this test exists to stop.
    assert.match(
        r.out,
        /(?:storage\.graph[\s\S]{0,160}?schema|schema[\s\S]{0,160}?storage\.graph)/i,
        `the failure must tie the missing schema to storage.graph — the database answered, so ` +
            `"could not reach database" is not the finding; got:\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /schema(?:\s+version)?/i,
        `the failure must name the graph schema (or schema version) it could not find; ` +
            `got:\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /schema[^\n]{0,40}\beso\b|"eso"[^\n]{0,40}schema/i,
        `the failure must name the configured schema "eso" next to the missing-schema verdict; ` +
            `got:\n${r.out.slice(0, 800)}`,
    );
    assert.match(
        r.out,
        /\.\/provision\.sh\s+alpha/,
        `the failure must name the command that fixes it (./provision.sh alpha); got:\n${r.out.slice(0, 800)}`,
    );
    assert.doesNotMatch(
        r.out,
        /could not reach database/i,
        `the database is reachable: reporting only "could not reach database" cannot see a missing ` +
            `schema (the Stage 8 defect); got:\n${r.out.slice(0, 800)}`,
    );
});

/**
 * A PostgreSQL v3 wire-protocol stand-in for "server up, schema `eso` not created yet".
 *
 * It is deliberately small: startup handshake (incl. SSLRequest refusal), AuthenticationOk, a
 * readable `server_version`, a successful `SELECT 1` health probe, and SQLSTATE `3F000`
 * `schema "eso" does not exist` for every other statement. It models no rows and no tables, so it
 * can prove verify *asks* about the schema; it cannot prove what a real PostgreSQL would answer.
 */
function schemaMissingPostgres(t) {
    const message = 'schema "eso" does not exist';
    const sockets = new Set();
    const cstring = (value) => Buffer.concat([Buffer.from(String(value), 'utf8'), Buffer.from([0])]);

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        let buffered = Buffer.alloc(0);
        let started = false;
        let failed = false;
        let lastQuery = '';

        const send = (type, payload = Buffer.alloc(0)) => {
            const header = Buffer.alloc(5);
            header.writeUInt8(type.charCodeAt(0), 0);
            header.writeInt32BE(payload.length + 4, 1);
            socket.write(Buffer.concat([header, payload]));
        };
        const readCString = (body, offset) => {
            const end = body.indexOf(0, offset);
            return { text: body.subarray(offset, end).toString('utf8'), next: end + 1 };
        };
        const errorResponse = () =>
            send(
                'E',
                Buffer.concat([
                    Buffer.from('S'),
                    cstring('ERROR'),
                    Buffer.from('V'),
                    cstring('ERROR'),
                    Buffer.from('C'),
                    cstring('3F000'),
                    Buffer.from('M'),
                    cstring(message),
                    Buffer.from([0]),
                ]),
            );
        const readyForQuery = () => send('Z', Buffer.from([0x49]));
        const isHealthProbe = () => /^\s*SELECT\s+1\s*;?\s*$/i.test(lastQuery);
        const rowDescription = () =>
            send(
                'T',
                Buffer.concat([
                    Buffer.from([0, 1]),
                    cstring('?column?'),
                    // table oid, attnum, type oid (int4), size, modifier, format
                    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 0, 4, 255, 255, 255, 255, 0, 0]),
                ]),
            );
        const healthRow = () => {
            rowDescription();
            send('D', Buffer.from([0, 1, 0, 0, 0, 1, 0x31]));
            send('C', cstring('SELECT 1'));
        };

        const onData = (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            for (;;) {
                if (!started) {
                    if (buffered.length < 8) return;
                    const length = buffered.readInt32BE(0);
                    if (length < 8 || buffered.length < length) return;
                    const code = buffered.readInt32BE(4);
                    buffered = buffered.subarray(length);
                    if (code === 80877103) {
                        socket.write('N'); // SSLRequest: no TLS, continue in the clear
                        continue;
                    }
                    if (code === 80877102) {
                        socket.destroy(); // CancelRequest
                        return;
                    }
                    started = true;
                    send('R', Buffer.alloc(4)); // AuthenticationOk
                    send('S', Buffer.concat([cstring('server_version'), cstring('17.0')]));
                    send('S', Buffer.concat([cstring('client_encoding'), cstring('UTF8')]));
                    send('K', Buffer.alloc(8)); // BackendKeyData
                    readyForQuery();
                    continue;
                }
                if (buffered.length < 5) return;
                const type = String.fromCharCode(buffered[0]);
                const length = buffered.readInt32BE(1);
                if (length < 4 || buffered.length < length + 1) return;
                const body = buffered.subarray(5, length + 1);
                buffered = buffered.subarray(length + 1);

                if (type === 'X') {
                    socket.destroy();
                    return;
                }
                if (failed) {
                    // PostgreSQL swallows everything until Sync after an error; mirror that so a
                    // driver that pipelines Parse/Bind/Execute is not left waiting.
                    if (type === 'S') {
                        failed = false;
                        readyForQuery();
                    }
                    continue;
                }
                if (type === 'Q') {
                    lastQuery = readCString(body, 0).text;
                    if (isHealthProbe()) healthRow();
                    else errorResponse();
                    readyForQuery();
                    continue;
                }
                if (type === 'P') {
                    const named = readCString(body, 0);
                    lastQuery = readCString(body, named.next).text;
                    if (isHealthProbe()) send('1'); // ParseComplete
                    else {
                        errorResponse();
                        failed = true;
                    }
                    continue;
                }
                if (type === 'D') {
                    if (String.fromCharCode(body[0]) === 'S') send('t', Buffer.from([0, 0]));
                    rowDescription();
                    continue;
                }
                if (type === 'B') {
                    send('2'); // BindComplete
                    continue;
                }
                if (type === 'E') {
                    if (isHealthProbe()) {
                        send('D', Buffer.from([0, 1, 0, 0, 0, 1, 0x31]));
                        send('C', cstring('SELECT 1'));
                    } else {
                        errorResponse();
                        failed = true;
                    }
                    continue;
                }
                if (type === 'S') readyForQuery(); // Sync
            }
        };

        socket.on('data', onData);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            t.after(() => {
                for (const socket of sockets) socket.destroy();
                server.close();
            });
            resolve({ port: server.address().port });
        });
    });
}
