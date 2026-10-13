#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeHostPack } from './host-pack-summary.mjs';
import {
    hostPackStatus,
    listHostProfileIds,
    createProject,
    listProjects,
    loadProject,
    projectsDir,
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
    return process.env.HARNESS_AGENT_ROOT_HOST || '~';
}

function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.join(ESO_ROOT, 'profiles');
}

function stateDir() {
    ensureProductState();
    return productStateDir();
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
    const applied = initProfile(project, profilesDir(), tenantsFile(), {
        dryRun: false,
    });

    const workspace = loadWorkspace();
    const idx = workspace.projects.findIndex((p) => p.id === project.id);
    const row = {
        id: project.id,
        displayName: project.displayName,
        root: applied.root,
        rootHost: applied.root,
        port: project.observe?.port || 8792,
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
            projectsDir: projectsDir(dir),
            pattern: '<projectsDir>/<id>.json',
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
         */
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
            return { ...project, hostPack };
        });
        json(res, 200, { ok: true, items });
        return;
    }

    if (p === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.displayName) {
            json(res, 400, { ok: false, error: 'displayName required' });
            return;
        }
        const doc = createProject(stateDir(), { displayName: body.displayName });
        json(res, 201, { ok: true, project: doc });
        return;
    }

    const match = p.match(/^\/api\/projects\/([^/]+)(\/preview|\/provision|\/reload|\/observe-health)?$/);
    if (match) {
        const id = decodeURIComponent(match[1]);
        const action = match[2];
        let project = loadProject(stateDir(), id);
        if (!project) {
            json(res, 404, { ok: false, error: 'not found' });
            return;
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
            if (body.observe) project.observe = { ...project.observe, ...body.observe };
            if (body.plugins) project.plugins = { ...project.plugins, ...body.plugins };
            if (body.hostMode) project.hostMode = body.hostMode;
            if (body.hostProfile) project.hostProfile = body.hostProfile;
            saveProject(stateDir(), project);
            json(res, 200, { ok: true, project });
            return;
        }

        if (action === '/observe-health' && req.method === 'GET') {
            const port = project.observe?.port || 8792;
            const observeBase =
                process.env.HARNESS_OBSERVE_HEALTH_BASE?.replace(/\/$/, '') ||
                `http://127.0.0.1:${port}`;
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
                    hint: 'Start Docker, then in harness-eso: ./harness up',
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
