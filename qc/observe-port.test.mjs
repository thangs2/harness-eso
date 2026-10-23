/**
 * The observe port is one fact with one owner (invariant A1).
 *
 * The defect this file exists for: `baplatform`'s Console document said `8792` while
 * `~/.harness/workspace.json` said `8793`. `harnessctl observatory restart --project baplatform` then
 * addressed compose project `harness-observatory-8792` — x79's stack — because the compose project
 * name was derived from the port. The `down` half of `restart` removed x79, `up` started a stack that
 * reported x79's health, and `deploy.sh` printed "baplatform ready" on `:8792`.
 *
 * What is asserted here is the invariant that prevents it, not the symptom: a port is claimed from
 * one registry, a conflict is an error, and a stack's identity never depends on its entrance.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    OBSERVE_CONTAINER_PORT,
    OBSERVE_PORT_BASE,
    assertPortAvailable,
    assignObservePort,
    claimObservePort,
    composeProjectName,
    normalizePort,
    observeUrlFor,
    portsInUse,
    projectIdByRoot,
} from '../packages/harness-foundation/src/observe-port.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');
const requireCjs = createRequire(import.meta.url);

/**
 * These modules read product state at call time, so the temp root set in a test must apply to the
 * import too. ESM `import()` is async; these have no top-level await, so `require` keeps the bodies
 * linear and lets the env override above take effect.
 */
function foundationModule(file) {
    return requireCjs(path.join(ESO_ROOT, 'packages', 'harness-foundation', 'src', file));
}

function workspace(projects) {
    return { version: 1, defaultProjectId: projects[0]?.id ?? null, projects };
}

test('a recorded port wins, so the registry is the only owner', () => {
    const ws = workspace([
        { id: 'x79', port: 8792 },
        { id: 'baplatform', port: 8793 },
    ]);
    assert.equal(claimObservePort(ws, 'x79'), 8792);
    assert.equal(claimObservePort(ws, 'baplatform'), 8793);
});

test('a project with no port takes the lowest free one, not 8792 by habit', () => {
    const ws = workspace([{ id: 'x79', port: 8792 }, { id: 'baplatform', port: 8793 }, { id: 'fineso' }]);
    assert.equal(claimObservePort(ws, 'fineso'), 8794);
});

test('a corrupted port record is treated as unknown, never adopted', () => {
    const ws = workspace([{ id: 'p', port: 'not-a-port' }, { id: 'q', port: 0 }]);
    assert.equal(normalizePort('not-a-port'), null);
    assert.equal(normalizePort(0), null);
    assert.equal(normalizePort(70000), null);
    assert.equal(claimObservePort(ws, 'p'), OBSERVE_PORT_BASE);
    // Allocation is a pure function of the registry, so an unrecorded answer is only stable once the
    // caller writes it back — `assignObservePort` is that write, and the next claim must agree.
    assert.equal(assignObservePort(ws, 'p'), OBSERVE_PORT_BASE);
    assert.equal(claimObservePort(ws, 'q'), OBSERVE_PORT_BASE + 1);
});

test('a preferred port is honoured only when nothing else owns it', () => {
    const ws = workspace([{ id: 'x79', port: 8792 }, { id: 'new' }]);
    assert.equal(claimObservePort(ws, 'new', { preferred: 9100 }), 9100);
    assert.equal(
        claimObservePort(ws, 'new', { preferred: 8792 }),
        8793,
        'asking for a taken port must fall back to a free one rather than share it',
    );
});

test('two projects on one port is an error that names the owner', () => {
    const ws = workspace([
        { id: 'x79', port: 8792, rootHost: '/w/x79' },
        { id: 'baplatform', port: 8792, rootHost: '/w/baplatform' },
    ]);
    assert.throws(
        () => assertPortAvailable(ws, 'baplatform', 8792),
        /already owned by project "x79"/,
        'the operator must be told which project holds the port',
    );
});

test('the port a project owns is never in conflict with itself', () => {
    const ws = workspace([{ id: 'x79', port: 8792 }]);
    assert.equal(assertPortAvailable(ws, 'x79', 8792), 8792);
    assert.deepEqual([...portsInUse(ws, 'x79').entries()], []);
});

test('assigning a port mutates the workspace row, so one write is enough', () => {
    const ws = workspace([{ id: 'x79', port: 8792 }, { id: 'new' }]);
    assert.equal(assignObservePort(ws, 'new'), 8793);
    assert.equal(ws.projects[1].port, 8793);
});

test('the compose stack is identified by project id, not by port', () => {
    assert.equal(composeProjectName('baplatform'), 'harness-observatory-baplatform');
    assert.notEqual(
        composeProjectName('baplatform'),
        composeProjectName('x79'),
        'two projects must never address one compose stack, whatever their ports are',
    );
    assert.throws(() => composeProjectName(''), /requires a project id/);
});

test('a project id with separators still yields a usable compose name', () => {
    assert.equal(composeProjectName('mu/web app'), 'harness-observatory-mu-web-app');
});

test('observeUrlFor takes the port from the registry and only the host from the caller', () => {
    const ws = workspace([{ id: 'x79', port: 8792 }]);
    assert.equal(observeUrlFor(ws, 'x79'), 'http://127.0.0.1:8792');
    assert.equal(
        observeUrlFor(ws, 'x79', { publicHost: 'host.docker.internal' }),
        'http://host.docker.internal:8792',
    );
});

test('a project is found by the directory a command ran from', () => {
    const ws = workspace([{ id: 'x79', root: '/w/x79' }, { id: 'bp', root: '/w/baplatform' }]);
    assert.equal(projectIdByRoot(ws, '/w/baplatform'), 'bp');
    assert.equal(projectIdByRoot(ws, '/w/unknown'), null);
});

// --- the two registries must agree -------------------------------------------------------------

test('provisioning writes one port into the consumer anchor and sidecar.env', (t) => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-port-state-'));
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-port-consumer-'));
    const prevState = process.env.HARNESS_PRODUCT_STATE_DIR;
    const prevProfiles = process.env.HARNESS_PROFILES_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = state;
    process.env.HARNESS_PROFILES_DIR = PROFILES_DIR;
    t.after(() => {
        if (prevState === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prevState;
        if (prevProfiles === undefined) delete process.env.HARNESS_PROFILES_DIR;
        else process.env.HARNESS_PROFILES_DIR = prevProfiles;
    });

    // Loaded after the temp product-state root is set — these read it at call time.
    const { projectDraftForConsumer, initProfile } = foundationModule('init-profile.mjs');

    const draft = projectDraftForConsumer(consumer, { projectId: 'bp', displayName: 'bp' });
    assert.equal(
        draft.observe.port,
        null,
        'a draft must not invent a port — that was the second registry that disagreed with the first',
    );

    const result = initProfile(draft, PROFILES_DIR, path.join(state, 'tenants.json'), {
        dryRun: false,
        verify: false,
        observePort: 8793,
    });
    assert.equal(result.observePort, 8793);
    assert.equal(result.observeUrl, 'http://127.0.0.1:8793');

    const anchor = JSON.parse(fs.readFileSync(path.join(consumer, 'harness.config.json'), 'utf8'));
    assert.equal(anchor.server.port, 8793, 'the consumer anchor must carry the claimed port');

    const sidecar = fs.readFileSync(path.join(consumer, '.harness', 'sidecar.env'), 'utf8');
    assert.ok(sidecar.includes('8793'), 'sidecar.env must point at this project');
    assert.ok(!sidecar.includes('8792'), 'sidecar.env must not keep a stale default port');
});

test('a host install refuses a missing port instead of defaulting to 8792', () => {
    const { applyHostProfiles } = foundationModule('host-install.mjs');
    assert.throws(
        () => applyHostProfiles('/tmp/does-not-matter', [{ id: 'cursor-superset' }], {}),
        /observePort is required/,
        'the silent `|| 8792` is what installed the wrong URL into a consumer',
    );
});

// --- one Console, many profiles ------------------------------------------------------------------

/** A stand-in Observatory that says which project it serves, so a wrong port is visible in the body. */
async function fakeObservatory(port, name) {
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, servedBy: name }));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return server;
}

/** Lowest free port at or above `start`, so the test does not collide with a running stack. */
async function freePort(start) {
    for (let port = start; port < start + 60; port += 1) {
        const ok = await new Promise((resolve) => {
            const probe = createServer();
            probe.once('error', () => resolve(false));
            probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
        });
        if (ok) return port;
    }
    throw new Error(`no free port near ${start}`);
}

/** Wait until `url` answers at all — the Console child has no readiness line a test can listen for. */
async function waitForHttp(url, attempts = 100) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(500) });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    throw new Error(`server did not answer ${url}`);
}

function writeProjectDoc(stateDir, doc) {
    const dir = path.join(stateDir, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 4));
}

test('each profile is probed on its own port, not the first one', async (t) => {
    /*
     * The bug, in one assertion: the Console carried a single `HARNESS_OBSERVE_HEALTH_BASE`
     * (`host.docker.internal:8792` in Docker) and fell back to each project's port only when that was
     * unset. With every stack named by port, one stack answered for all rows and the other projects
     * looked healthy while their own containers were never started.
     */
    const base = await freePort(9310);
    const a = await fakeObservatory(base, 'alpha');
    const b = await fakeObservatory(base + 1, 'beta');
    t.after(() => {
        a.close();
        b.close();
    });

    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-console-state-'));
    const prevState = process.env.HARNESS_PRODUCT_STATE_DIR;
    const prevPort = process.env.HARNESS_CONSOLE_PORT;
    const prevHost = process.env.HARNESS_CONSOLE_HOST;
    const prevPublic = process.env.HARNESS_OBSERVE_PUBLIC_HOST;
    process.env.HARNESS_PRODUCT_STATE_DIR = state;
    process.env.HARNESS_PROFILES_DIR = PROFILES_DIR;
    process.env.HARNESS_CONSOLE_HOST = '127.0.0.1';
    process.env.HARNESS_CONSOLE_PORT = String(await freePort(base + 30));
    delete process.env.HARNESS_OBSERVE_PUBLIC_HOST;
    t.after(() => {
        for (const [k, v] of [
            ['HARNESS_PRODUCT_STATE_DIR', prevState],
            ['HARNESS_CONSOLE_PORT', prevPort],
            ['HARNESS_CONSOLE_HOST', prevHost],
            ['HARNESS_OBSERVE_PUBLIC_HOST', prevPublic],
        ]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    const { saveWorkspace } = foundationModule('workspace-store.mjs');
    saveWorkspace(
        workspace([
            { id: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', port: base },
            { id: 'beta', root: '/w/beta', rootHost: '/w/beta', port: base + 1 },
        ]),
    );
    /*
     * Registry v2: the project document IS the registry entry, so the folder below is legacy state —
     * the one operators still have on disk. The loader must fold it in, let the claimed row win the
     * port, and then delete the folder.
     */
    writeProjectDoc(state, {
        version: 1,
        id: 'beta',
        displayName: 'beta',
        agentRepo: { root: '/w/beta' },
        observe: { port: 8792 },
    });

    // Run the Console as a child: `boot()` keeps its server in a local and starts an ingest loop that
    // is not `unref`ed, so an in-process copy would keep the runner alive after the assertions pass.
    const consolePort = Number(process.env.HARNESS_CONSOLE_PORT);
    const child = fork(
        path.join(ESO_ROOT, 'packages', 'harness-console-server', 'src', 'server.mjs'),
        [],
        { env: { ...process.env, HARNESS_CONSOLE_PORT: String(consolePort) }, stdio: 'ignore' },
    );
    t.after(() => child.kill('SIGKILL'));
    await waitForHttp(`http://127.0.0.1:${consolePort}/health`);

    const health = async (id) => {
        const res = await fetch(`http://127.0.0.1:${consolePort}/api/projects/${id}/observe-health`);
        return { status: res.status, body: await res.json() };
    };

    const alpha = await health('alpha');
    const beta = await health('beta');
    assert.equal(alpha.body.servedBy, 'alpha');
    assert.equal(
        beta.body.servedBy,
        'beta',
        'beta must reach its own stack — reaching alpha is the defect this route was rewritten for',
    );

    const ports = await fetch(`http://127.0.0.1:${consolePort}/api/observe-ports`).then((r) => r.json());
    assert.deepEqual(
        ports.items.map((p) => [p.id, p.port]),
        [
            ['alpha', base],
            ['beta', base + 1],
        ],
    );

    const projects = await fetch(`http://127.0.0.1:${consolePort}/api/projects`).then((r) => r.json());
    const betaRow = projects.items.find((p) => p.id === 'beta');
    assert.equal(betaRow.observe.port, base + 1, 'the list reports the port the stack actually uses');
    /*
     * v1 kept the port in two files, so the list had to report a divergence between them. v2 keeps it
     * in one, which means a divergence is impossible rather than merely reported — the documented
     * port and the claimed port are the same number, and `portConflict` is null.
     */
    assert.equal(betaRow.portConflict, null, 'one registry cannot disagree with itself');
    assert.deepEqual(
        projects.items.map((p) => p.id).sort(),
        ['alpha', 'beta'],
        'the list is the registry: a project the workspace knew is never missing from it',
    );
    assert.equal(
        fs.existsSync(path.join(state, 'projects')),
        false,
        'the legacy per-project folder is folded in and removed',
    );
});

/* ── the container port is a constant, and it is not the host-port base ─────────────────────────── */

test('the in-container port is one constant, distinct from the host-port base', () => {
    /*
     * Every stack published its own host port (8792, 8793, …) onto the *same* in-container port, and
     * that port was also `OBSERVE_PORT_BASE`. So `docker ps` read as four running 8792s, which is
     * precisely the ambiguity a per-project port exists to remove. Two questions, two constants.
     */
    assert.notEqual(
        OBSERVE_CONTAINER_PORT,
        OBSERVE_PORT_BASE,
        'a container port equal to the host base is what made every stack look like port 8792',
    );
    assert.equal(OBSERVE_CONTAINER_PORT, 8790);
    assert.ok(
        OBSERVE_CONTAINER_PORT < OBSERVE_PORT_BASE,
        'the container port sits below the allocation range, so a host port can never collide with it',
    );
});

test('the compose mapping and the image agree on the container port', () => {
    const compose = fs.readFileSync(path.join(ESO_ROOT, 'compose.harness.yml'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(ESO_ROOT, 'observatory.Dockerfile'), 'utf8');

    assert.match(
        compose,
        new RegExp(`HARNESS_OBSERVE_CONTAINER_PORT:-${OBSERVE_CONTAINER_PORT}\\}`),
        'the mapping must default the container side to the constant, not to the host base',
    );
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${OBSERVE_CONTAINER_PORT}/health`), 'the healthcheck probes inside the container');
    assert.match(dockerfile, new RegExp(`EXPOSE ${OBSERVE_CONTAINER_PORT}`));
    assert.match(dockerfile, new RegExp(`"--port", "${OBSERVE_CONTAINER_PORT}"`));
    assert.doesNotMatch(
        dockerfile,
        new RegExp(`--port", "${OBSERVE_PORT_BASE}"`),
        'the image must not start on the host-port base — that is an entrance, not a bind address',
    );
});
