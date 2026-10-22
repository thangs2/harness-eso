#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeHostPack } from './host-pack-summary.mjs';
import {
    hostPackStatus,
    listHostProfileIds,
    createProject,
    listProjects,
    loadProject,
    saveProject,
} from '@mu/harness-foundation/project-registry';
import { initProfile, reloadHostConfig } from '@mu/harness-foundation/init-profile';
import {
    ensureProductState,
    loadWorkspace,
    productStateDir,
    saveWorkspace,
    syncTenantsFromWorkspace,
    tenantsFile,
} from '@mu/harness-foundation/workspace';
import {
    assertPortAvailable,
    assignObservePort,
    claimObservePort,
    normalizePort,
    observeUrlFor,
} from '@mu/harness-foundation/observe-port';
// Consent records — the `ask` tier's human half. Imported by subpath rather than from the package root
// so the console server does not pull the SQLite port into its cold start for one JSON file.
import {
    consentDir,
    grantConsent,
    liveConsents,
    readConsentStore,
    revokeConsent,
} from '@mu/harness-foundation/consent';
import {
    consumerTypesafeEnvConfigured,
    resolveApiKey,
    smokeTypesafe,
} from './jev-smoke.mjs';

const CONSOLE_PORT = Number.parseInt(process.env.HARNESS_CONSOLE_PORT || '8791', 10);
const CONSOLE_HOST = process.env.HARNESS_CONSOLE_HOST || '127.0.0.1';
const ENTRY = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(ENTRY), '..');
const ESO_ROOT = process.env.HARNESS_ESO_ROOT || path.resolve(PKG_ROOT, '../..');

/**
 * Agent workspace root offered to the wizard. Deliberately NOT the harness-eso
 * checkout: a consumer is a repo that USES the harness, and provisioning the
 * product repo writes host hooks into the repo that ships them.
 */
function defaultAgentRoot() {
    const raw = process.env.HARNESS_AGENT_ROOT_HOST || process.env.HARNESS_AGENT_ROOT || '~';
    return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.join(ESO_ROOT, 'profiles');
}

function stateDir() {
    ensureProductState();
    return productStateDir();
}

/**
 * The base URL of a project's Observatory, resolved through the one port registry.
 *
 * `HARNESS_OBSERVE_PUBLIC_HOST` exists for the containerised Console, which reaches the host as
 * `host.docker.internal`. It names a transport, never a port — the Console used to take a whole
 * `HARNESS_OBSERVE_HEALTH_BASE` URL with a hard-coded `:8792`, so every project in a container probed
 * the first project's stack and saw it healthy.
 *
 * @param {string} projectId
 */
function observeBaseFor(projectId) {
    const host = (process.env.HARNESS_OBSERVE_PUBLIC_HOST || '127.0.0.1').trim();
    return observeUrlFor(loadWorkspace(), projectId, { publicHost: host });
}

function json(res, status, data) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    return JSON.parse(raw);
}

function consoleDist() {
    const p = path.join(ESO_ROOT, 'packages/harness-console/dist');
    return fs.existsSync(path.join(p, 'index.html')) ? p : '';
}

function serveStatic(req, res) {
    const dist = consoleDist();
    if (!dist) return false;
    const url = new URL(req.url, `http://${CONSOLE_HOST}`);
    if (url.pathname.startsWith('/api/')) return false;
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(dist, p);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (fs.existsSync(path.join(dist, 'index.html'))) {
            const html = fs.readFileSync(path.join(dist, 'index.html'));
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return true;
        }
        return false;
    }
    const ext = path.extname(file);
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
    return true;
}

function provisionProject(project) {
    const dir = stateDir();
    const workspace = loadWorkspace();
    /*
     * Claim before provisioning, not after. `initProfile` writes the port into
     * `harness.config.json`, `sidecar.env` and `host-bootstrap.json`, so a project that had no port
     * yet must have one recorded before those files are generated — otherwise the consumer is
     * provisioned against a number the registry never agreed to.
     */
    const port = assignObservePort(workspace, project.id, { preferred: project.observe?.port });
    const applied = initProfile(
        { ...project, observe: { ...(project.observe || {}), port } },
        profilesDir(),
        tenantsFile(),
        {
            dryRun: false,
        },
    );

    const idx = workspace.projects.findIndex((p) => p.id === project.id);
    const row = {
        id: project.id,
        displayName: project.displayName,
        root: applied.root,
        rootHost: applied.root,
        port,
        profile: 'generic-eso',
        consoleProject: true,
    };
    if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
    else workspace.projects.push(row);
    workspace.defaultProjectId = workspace.defaultProjectId || project.id;
    saveWorkspace(workspace);
    syncTenantsFromWorkspace(workspace);

    project.status = 'provisioned';
    project.provisionedAt = new Date().toISOString();
    project.observe = { ...(project.observe || {}), port };
    saveProject(dir, project);

    return { ok: true, files: applied.files, observeUrl: applied.observeUrl };
}

async function route(req, res) {
    const url = new URL(req.url, `http://${CONSOLE_HOST}:${CONSOLE_PORT}`);
    const p = url.pathname;

    if (p === '/health') {
        json(res, 200, { ok: true, service: 'harness-console', port: CONSOLE_PORT });
        return;
    }

    if (p === '/api/host-profiles' && req.method === 'GET') {
        const dir = profilesDir();
        const ids = listHostProfileIds(dir);
        const items = ids.map((id) => {
            const fp = path.join(dir, 'host', `${id}.json`);
            const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const trees = [];
            if (doc.cursor) trees.push('cursor');
            if (doc.agents) trees.push('agents');
            return {
                id: doc.id,
                label: doc.label,
                description: doc.description,
                trees,
                supersetFor: trees.length === 1 ? trees[0] : null,
            };
        });
        json(res, 200, { ok: true, items });
        return;
    }

    if (p === '/api/plugin-catalog' && req.method === 'GET') {
        const catPath = path.join(profilesDir(), 'plugin-catalog.json');
        if (!fs.existsSync(catPath)) {
            json(res, 404, { ok: false, error: 'plugin-catalog.json missing' });
            return;
        }
        json(res, 200, JSON.parse(fs.readFileSync(catPath, 'utf8')));
        return;
    }

    if (p === '/api/jev/status' && req.method === 'GET') {
        const consumerRoot = url.searchParams.get('consumerRoot') || '';
        const consumer = consumerTypesafeEnvConfigured(consumerRoot);
        const serverKey = Boolean((process.env.TYPESAFE_API_KEY || '').trim());
        json(res, 200, {
            ok: true,
            serverEnvKey: serverKey,
            consumer,
            ready: serverKey || consumer.keyConfigured,
        });
        return;
    }

    if (p === '/api/jev/smoke-test' && req.method === 'POST') {
        const body = await readBody(req);
        const apiKey = resolveApiKey(body.apiKey);
        if (!apiKey) {
            json(res, 400, {
                ok: false,
                error: 'missing_api_key',
                message: 'Paste key for one-off test or set TYPESAFE_API_KEY in Console server env.',
            });
            return;
        }
        try {
            const result = await smokeTypesafe({
                apiKey,
                baseUrl: body.baseUrl,
                model: body.model,
            });
            json(res, result.ok ? 200 : 502, { ...result, persisted: false });
        } catch (err) {
            json(res, 502, { ok: false, error: 'network', message: err.message, persisted: false });
        }
        return;
    }

    if (p === '/api/meta' && req.method === 'GET') {
        const dir = stateDir();
        json(res, 200, {
            ok: true,
            productStateDir: dir,
            // The registry is one file now. Kept in the payload because the Console shows the path
            // an operator should back up, and a stale `projects/` hint would send them to a folder
            // the migration deletes.
            registryPath: path.join(dir, 'workspace.json'),
            pattern: '<productStateDir>/workspace.json · projects[]',
            // Consumer repo must be chosen explicitly — never the harness-eso checkout.
            agentRootDefault: defaultAgentRoot(),
        });
        return;
    }

    if (p === '/api/projects' && req.method === 'GET') {
        /*
         * Each project carries its host pack health.
         *
         * Reported on the list rather than behind a per-project call because the failure this is
         * for is invisible in the other direction: a consumer whose pack is broken or missing still
         * appears as "provisioned", so the operator only learns about it from an IDE that silently
         * stopped guarding. One cheap `readFile`+`hash` per project makes it visible where projects
         * are already listed.
         *
         * The port is also reconciled here: every project claims one from the workspace, and a
         * document that disagrees is reported (`portConflict`) rather than silently repaired — two
         * registries disagreeing is the defect, and hiding it in a read route would keep it invisible.
         */
        const workspace = loadWorkspace();
        const items = listProjects(stateDir()).map((project) => {
            const root = project.agentRepo?.root;
            let hostPack = null;
            if (root) {
                try {
                    hostPack = summarizeHostPack(hostPackStatus(root));
                } catch (err) {
                    hostPack = { state: 'error', detail: String(err?.message || err) };
                }
            }
            const recorded = claimObservePort(workspace, project.id);
            const docPort = normalizePort(project.observe?.port);
            const owners = (workspace.projects ?? []).filter((p) => normalizePort(p.port) === recorded);
            const rival = owners.find((p) => p.id !== project.id);
            return {
                ...project,
                hostPack,
                observe: { ...(project.observe || {}), port: recorded, recorded },
                portConflict:
                    docPort !== null && docPort !== recorded
                        ? {
                              document: docPort,
                              workspace: recorded,
                              detail: `project document says ${docPort}, workspace records ${recorded}`,
                          }
                        : rival
                          ? { owner: rival.id, detail: `port ${recorded} is also owned by "${rival.id}"` }
                          : null,
            };
        });
        json(res, 200, { ok: true, items });
        return;
    }

    if (p === '/api/observe-ports' && req.method === 'GET') {
        /*
         * The registry as the Console renders it: every project, its port, and the compose identity
         * that stack uses. One Console serves every project's Observatory (each on its own port), so
         * this route is what lets the UI open the right one instead of assuming :8792.
         */
        const workspace = loadWorkspace();
        const items = workspace.projects.map((project) => ({
            id: project.id,
            displayName: project.displayName,
            root: project.rootHost || project.root,
            port: claimObservePort(workspace, project.id),
            observeUrl: observeBaseFor(project.id),
            defaultProject: project.id === workspace.defaultProjectId,
        }));
        json(res, 200, { ok: true, items });
        return;
    }

    if (p === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.displayName) {
            json(res, 400, { ok: false, error: 'displayName required' });
            return;
        }
        /*
         * The port is claimed here, through the one resolver, and written into both registries by
         * `createProject`/`saveWorkspace` callers. A draft used to get `8792` from
         * `defaultProjectDraft`, which is how a second project started life pointing at the first
         * project's stack.
         */
        const workspace = loadWorkspace();
        let port;
        try {
            // Reserve the id first so the port is claimed for the id that will actually be used.
            const doc = createProject(stateDir(), {
                displayName: body.displayName,
                root: String(body.root || '').trim(),
            });
            port = assignObservePort(workspace, doc.id, { preferred: body.port });
            doc.observe = { ...(doc.observe || {}), port, source: 'workspace' };
            saveProject(stateDir(), doc);

            const row = {
                id: doc.id,
                displayName: doc.displayName,
                root: String(body.root || '').trim(),
                rootHost: String(body.root || '').trim(),
                port,
                profile: 'generic-eso',
                consoleProject: true,
            };
            const idx = workspace.projects.findIndex((x) => x.id === doc.id);
            if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
            else workspace.projects.push(row);
            workspace.defaultProjectId = workspace.defaultProjectId || doc.id;
            saveWorkspace(workspace);
            syncTenantsFromWorkspace(workspace);
            json(res, 201, { ok: true, project: doc });
        } catch (err) {
            json(res, 400, { ok: false, error: String(err?.message || err) });
        }
        return;
    }

    const match = p.match(
        /^\/api\/projects\/([^/]+)(\/preview|\/provision|\/reload|\/observe-health|\/consent)?$/,
    );
    if (match) {
        const id = decodeURIComponent(match[1]);
        const action = match[2];
        let project = loadProject(stateDir(), id);
        if (!project) {
            json(res, 404, { ok: false, error: 'not found' });
            return;
        }

        /*
         * Human consent for the `ask` path tier.
         *
         * This is the **only** writer of a consent record, and that is its purpose: the record lives in
         * product state (outside the repo) so the agent's write gates cannot reach it, and the console is
         * a surface a human operates. A route an agent could call would put the record back inside the
         * agent's reach and the tier would mean nothing.
         */
        if (action === '/consent') {
            if (req.method === 'GET') {
                json(res, 200, {
                    ok: true,
                    dir: consentDir(),
                    live: liveConsents(id),
                    all: readConsentStore(id).records,
                });
                return;
            }
            if (req.method === 'POST') {
                const body = await readBody(req);
                if (!body?.path) {
                    json(res, 400, { ok: false, error: 'consent needs a path' });
                    return;
                }
                try {
                    const record = grantConsent(id, {
                        path: body.path,
                        reason: body.reason,
                        ttlSeconds: Number(body.ttlSeconds) || undefined,
                        requestId: body.requestId,
                        // Named, not implied. If a future channel grants consent it records its own
                        // identity here, and an out-of-band approval stays distinguishable.
                        approvedBy: 'human:console',
                    });
                    json(res, 201, { ok: true, record });
                } catch (err) {
                    json(res, 400, { ok: false, error: String(err?.message || err) });
                }
                return;
            }
            if (req.method === 'DELETE') {
                const body = await readBody(req);
                const query = url.searchParams;
                const out = revokeConsent(id, {
                    path: body?.path || query.get('path') || undefined,
                    id: body?.id || query.get('id') || undefined,
                });
                json(res, 200, { ok: true, ...out });
                return;
            }
        }

        if (!action && req.method === 'GET') {
            json(res, 200, { ok: true, project });
            return;
        }

        if (!action && req.method === 'PATCH') {
            const body = await readBody(req);
            delete body.id;
            project = { ...project, ...body, id: project.id, version: project.version };
            if (body.agentRepo) project.agentRepo = { ...project.agentRepo, ...body.agentRepo };
            if (body.plugins) project.plugins = { ...project.plugins, ...body.plugins };
            if (body.hostMode) project.hostMode = body.hostMode;
            if (body.hostProfile) project.hostProfile = body.hostProfile;
            /*
             * A port edited in the Console is written to **both** registries, and it is refused when
             * another project already owns it. Accepting it for the document only is what produced the
             * divergence this fix removes: the document said one number, the workspace another, and
             * whichever process read the document first served the wrong consumer.
             */
            if (body.observe) {
                const workspace = loadWorkspace();
                const wanted = normalizePort(body.observe.port);
                const recorded = claimObservePort(workspace, project.id);
                if (wanted !== null && wanted !== recorded) {
                    try {
                        assertPortAvailable(workspace, project.id, wanted);
                    } catch (err) {
                        json(res, 409, { ok: false, error: 'port_conflict', message: err.message });
                        return;
                    }
                    assignObservePort(workspace, project.id, { preferred: wanted });
                    const row = workspace.projects.find((x) => x.id === project.id);
                    if (row) row.port = wanted;
                    saveWorkspace(workspace);
                    syncTenantsFromWorkspace(workspace);
                }
                project.observe = { ...project.observe, ...body.observe, port: wanted ?? recorded };
            }
            saveProject(stateDir(), project);
            json(res, 200, { ok: true, project });
            return;
        }

        if (action === '/observe-health' && req.method === 'GET') {
            /*
             * Per-project, always. This used to prefer one `HARNESS_OBSERVE_HEALTH_BASE` URL and only
             * fall back to the project's port, so a Console in Docker probed `:8792` for every
             * project — every row reported "healthy" because one stack answered, whichever project it
             * belonged to. The project id decides the port; the host is only a transport choice.
             */
            let observeBase;
            try {
                observeBase = observeBaseFor(id);
            } catch (err) {
                json(res, 400, { ok: false, error: 'port_unresolved', message: String(err?.message || err) });
                return;
            }
            try {
                const upstream = await fetch(`${observeBase}/health`, {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(4000),
                });
                const body = await upstream.text();
                res.writeHead(upstream.status, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(body);
            } catch (err) {
                json(res, 503, {
                    ok: false,
                    error: 'observe_unreachable',
                    message: err.message,
                    observeUrl: observeBase,
                    hint: `Start this project's stack: harnessctl observatory up --project ${id}`,
                });
            }
            return;
        }

        if (action === '/preview' && req.method === 'GET') {
            try {
                const planned = initProfile(project, profilesDir(), tenantsFile(), { dryRun: true });
                json(res, 200, {
                    ok: true,
                    root: planned.root,
                    files: planned.files,
                });
            } catch (err) {
                json(res, 400, { ok: false, error: err.message });
            }
            return;
        }

        if (action === '/provision' && req.method === 'POST') {
            try {
                json(res, 200, provisionProject(project));
            } catch (err) {
                json(res, 400, { ok: false, error: err.message });
            }
            return;
        }

        // Rewrite host config: hooks.json (merged + de-duplicated), hook bins, sidecar.env,
        // and .harness/host-bootstrap.json with a fresh appliedAt.
        // Body `{ "tenant": true }` additionally rewrites the tenant anchor
        // (harness.config.json) — the repair path for an anchor that `create-if-missing`
        // would otherwise leave stale forever.
        if (action === '/reload' && req.method === 'POST') {
            try {
                const body = await readBody(req);
                json(
                    res,
                    200,
                    reloadHostConfig(project, profilesDir(), {
                        tenantsRegistryPath: tenantsFile(),
                        forceTenant: body?.tenant === true,
                    }),
                );
            } catch (err) {
                json(res, 400, { ok: false, error: err.message });
            }
            return;
        }
    }

    if (req.method === 'GET' && serveStatic(req, res)) return;

    json(res, 404, { error: 'not found' });
}

function boot() {
    /*
     * Product state defaults to `~/.harness` (foundation default). It used to be forced to
     * `<checkout>/.harness`, which tied the console's project list to the source tree — and inside
     * the container that path does not exist at all, so the mount is what supplies it.
     */
    if (!process.env.HARNESS_PROFILES_DIR) {
        process.env.HARNESS_PROFILES_DIR = profilesDir();
    }
    ensureProductState();

    const server = http.createServer((req, res) => {
        route(req, res).catch((err) => json(res, 500, { error: err.message }));
    });

    server.listen(CONSOLE_PORT, CONSOLE_HOST, () => {
        console.error(`Harness Console http://${CONSOLE_HOST}:${CONSOLE_PORT}`);
    });
}

function isDirectRun() {
    if (import.meta.main) return true;
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(ENTRY);
}

if (isDirectRun()) {
    boot();
}

export { boot, CONSOLE_PORT };
