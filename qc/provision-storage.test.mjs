// RED — ESO-484 / BIP-1_8 (slice 1.8): provision graph storage at `init profile`.
//
// These five tests are the Stage 7 negative control for `sdlc/10.test/66..69`. They are written
// BEFORE the behaviour exists, so every one of them must fail on an assertion — never on a missing
// import, a syntax error or a fixture problem. The contract they pin (and the builder must satisfy)
// lives in the packets, §6:
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
