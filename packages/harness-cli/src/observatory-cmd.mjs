import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';
import { findProject, findProjectByRoot, loadWorkspace, resolveProject } from '@mu/harness-foundation/workspace';
import {
    OBSERVE_PORT_BASE,
    assertPortAvailable,
    claimObservePort,
    composeProjectName,
    normalizePort,
} from '@mu/harness-foundation/observe-port';

const COMPOSE_FILE = path.join(ESO_ROOT, 'compose.harness.yml');

function die(msg) {
    console.error(`observatory: ${msg}`);
    process.exit(1);
}

function requireDocker() {
    const which = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    if (which.error || which.status !== 0) {
        die('docker compose v2 required — install Docker Desktop / Engine');
    }
    const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
    if (info.status !== 0) die('Docker daemon not running');
}

function hasHarnessConfig(dir) {
    return fs.existsSync(path.join(dir, 'harness.config.json'));
}

function tryResolveConsumerFromCwd() {
    let d = process.cwd();
    while (d && d !== path.dirname(d)) {
        if (hasHarnessConfig(d)) return d;
        d = path.dirname(d);
    }
    return null;
}

/**
 * Everything a compose invocation needs, resolved once.
 *
 * Two facts used to be the same variable — `COMPOSE_PROJECT_NAME = harness-observatory-${port}` — and
 * that is what made `deploy.sh baplatform` bring up x79's stack: baplatform's document said 8792, so
 * it addressed the project x79 was already running, and the `down` half of `restart` removed it. A
 * port is an entrance; the stack's identity is the project id and nothing else.
 *
 * @param {{ repoOptional?: boolean, projectId?: string|null, consumerPath?: string|null, port?: number|null }} opts
 */
function composeEnv(opts = {}) {
    const env = { ...process.env };
    env.HOME = env.HOME || os.homedir();
    env.HARNESS_AGENT_ROOT = env.HARNESS_AGENT_ROOT || path.join(env.HOME, 'Workspaces');
    env.HARNESS_CURSOR_HOME = env.HARNESS_CURSOR_HOME || path.join(env.HOME, '.cursor');
    env.HARNESS_GEMINI_HOME = env.HARNESS_GEMINI_HOME || path.join(env.HOME, '.gemini');

    const workspace = loadWorkspace();
    const projectId = opts.projectId ?? null;

    env.HARNESS_OBSERVE_PORT = String(
        opts.port ?? (projectId ? claimObservePort(workspace, projectId) : OBSERVE_PORT_BASE),
    );
    env.COMPOSE_PROJECT_NAME = projectId
        ? composeProjectName(projectId)
        : env.COMPOSE_PROJECT_NAME || composeProjectName('shared');

    let consumerPath = opts.consumerPath || env.HARNESS_REPO_ROOT;
    if (!consumerPath && projectId) {
        const project = findProject(workspace, projectId);
        consumerPath = project?.rootHost || project?.root || null;
    }
    if (!consumerPath) consumerPath = tryResolveConsumerFromCwd();
    if (consumerPath) env.HARNESS_REPO_ROOT = path.resolve(consumerPath);
    if (!env.HARNESS_REPO_ROOT && opts.repoOptional) env.HARNESS_REPO_ROOT = ESO_ROOT;

    if (!env.HARNESS_REPO_ROOT) {
        die(`chưa có dự án — thêm trong http://127.0.0.1:${OBSERVE_PORT_BASE}/projects hoặc harnessctl observatory up --project <id>`);
    }

    return env;
}

function compose(args, opts = {}) {
    const env = composeEnv(opts);
    const result = spawnSync(
        'docker',
        ['compose', '-p', env.COMPOSE_PROJECT_NAME, '-f', COMPOSE_FILE, '--project-directory', ESO_ROOT, ...args],
        { cwd: ESO_ROOT, env, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function curlJson(url, method = 'GET') {
    const args = ['-fsS', '-X', method, url];
    const r = spawnSync('curl', args, { encoding: 'utf8' });
    if (r.status !== 0) die(`curl failed: ${url}`);
    return r.stdout;
}

function cmdUp(rest, opts) {
    let foreground = false;
    let doBuild = true;
    for (const a of rest) {
        if (a === '-f' || a === '--foreground') foreground = true;
        else if (a === '--no-build') doBuild = false;
        else if (a === '-h' || a === '--help') {
            console.log('observatory up [--foreground] [--no-build]');
            process.exit(0);
        } else die(`unknown flag: ${a}`);
    }
    const upArgs = ['up'];
    if (doBuild) upArgs.push('--build');
    if (!foreground) upArgs.push('-d');
    const code = compose(upArgs, opts);
    if (code !== 0) process.exit(code);
    const env = composeEnv(opts);
    const port = env.HARNESS_OBSERVE_PORT;
    console.log('');
    console.log(`Observatory: http://127.0.0.1:${port}/  (compose project: ${env.COMPOSE_PROJECT_NAME})`);
    console.log(`Consumer mount: ${env.HARNESS_REPO_ROOT} → /data/repo (read-only)`);
    console.log(`Observe SQLite: Docker volume observe-data → /data/observe/<projectId>/harness.db`);
    console.log(`Transcripts: Cursor (${env.HARNESS_CURSOR_HOME}) / Antigravity (${env.HARNESS_GEMINI_HOME}) → container (REQUEST spine)`);
    console.log(
        opts.projectId
            ? `Restart only this stack: harnessctl observatory restart --project ${opts.projectId}`
            : `Stop this stack: docker compose -p ${env.COMPOSE_PROJECT_NAME} down`,
    );
}

function cmdHealth(port) {
    const out = curlJson(`http://127.0.0.1:${port}/health`);
    process.stdout.write(out);
    if (!out.endsWith('\n')) console.log('');
}

function cmdSmoke(port) {
    const base = `http://127.0.0.1:${port}`;
    console.log(`==> GET ${base}/health`);
    console.log(curlJson(`${base}/health`));
    console.log(`==> GET ${base}/api/tenant`);
    try {
        console.log(curlJson(`${base}/api/tenant`));
    } catch {
        console.log('(tenant endpoint not responding or not provisioned)');
    }
    console.log(`==> GET ${base}/api/ingest/status`);
    console.log(curlJson(`${base}/api/ingest/status`));
    console.log(`==> POST ${base}/api/ingest/run`);
    console.log(curlJson(`${base}/api/ingest/run`, 'POST'));
    console.log(`==> GET ${base}/api/requests?limit=5`);
    console.log(curlJson(`${base}/api/requests?limit=5`));
}

/**
 * Resolve which project this invocation is about, or none.
 *
 * Precedence is the operator's, not the environment's: `--project` (or a consumer path that maps to
 * one) wins outright. The old code let an inherited `HARNESS_OBSERVE_PORT` beat the project's own
 * record, which is how a shell variable turned one deploy into another project's deploy.
 */
function resolveTarget(opts) {
    const ws = loadWorkspace();
    const consumerPath = opts.consumerPath || process.env.HARNESS_REPO_ROOT || null;
    if (opts.projectId) {
        const project = findProject(ws, opts.projectId);
        if (!project) {
            die(`không tìm thấy dự án "${opts.projectId}" — harnessctl configure list`);
        }
        return { workspace: ws, project };
    }
    if (consumerPath) {
        const project = findProjectByRoot(ws, consumerPath);
        if (project) return { workspace: ws, project };
        return { workspace: ws, project: null, consumerPath };
    }
    const fromCwd = tryResolveConsumerFromCwd();
    if (fromCwd) {
        const project = findProjectByRoot(ws, fromCwd);
        if (project) return { workspace: ws, project, consumerPath: fromCwd };
        return { workspace: ws, project: null, consumerPath: fromCwd };
    }
    try {
        return { workspace: ws, project: resolveProject(ws, null) };
    } catch {
        return { workspace: ws, project: null };
    }
}

/**
 * The host port this invocation should talk to.
 *
 * A named project's recorded port is authoritative; `--port` is an explicit override; an inherited
 * `HARNESS_OBSERVE_PORT` only decides when nothing else does. Previously the environment outranked the
 * project, so a stale shell variable silently retargeted the command.
 *
 * @param {string|null} projectId
 * @param {{ projects?: Array<object> }} workspace
 * @param {{ port?: number }} opts
 */
function resolvePort(projectId, workspace, opts) {
    const explicit = normalizePort(opts.port);
    if (explicit !== null) return explicit;
    if (projectId) return claimObservePort(workspace, projectId);
    const fromEnv = normalizePort(process.env.HARNESS_OBSERVE_PORT);
    return fromEnv ?? OBSERVE_PORT_BASE;
}

/**
 * @param {string} subcommand
 * @param {string[]} restArgs
 * @param {{ projectId?: string, consumerPath?: string, port?: number }} [opts]
 */
export function runObservatory(subcommand, restArgs = [], opts = {}) {
    applyWorkspaceEnv();
    requireDocker();

    const target = resolveTarget(opts);
    const project = target.project;
    const projectId = project?.id ?? null;

    /*
     * Warning, then refusal. Two projects recorded on one port is a corrupted registry, and acting on
     * it would start a stack that answers for a different consumer — the failure a healthy `/health`
     * cannot detect. `down`/`status`/`logs` only need the stack's identity, so they are still allowed
     * to run: an operator must be able to stop the stack that is already wrong.
     */
    const port = resolvePort(projectId, target.workspace, opts);
    if ((subcommand === 'up' || subcommand === 'restart') && projectId) {
        try {
            assertPortAvailable(target.workspace, projectId, port);
        } catch (err) {
            die(err.message);
        }
    }

    const composeOpts = {
        projectId,
        consumerPath: target.consumerPath ?? project?.rootHost ?? project?.root ?? null,
        port,
        repoOptional:
            subcommand === 'build' || subcommand === 'down' || subcommand === 'status' || subcommand === 'ps' || subcommand === 'logs',
    };

    switch (subcommand) {
        case 'up':
            cmdUp(restArgs, composeOpts);
            return;
        case 'down':
            process.exit(compose(['down', ...restArgs], composeOpts));
        case 'restart':
            /*
             * `down` is addressed by the same project id as `up`. When it was addressed by port, a
             * project whose document disagreed with the registry tore down the other project's stack
             * here and then started its own — visible only as a log line from the wrong consumer.
             */
            compose(['down'], composeOpts);
            cmdUp(restArgs, composeOpts);
            return;
        case 'status':
        case 'ps':
            process.exit(compose(['ps', ...restArgs], composeOpts));
        case 'health':
            cmdHealth(port);
            return;
        case 'logs':
            process.exit(compose(['logs', '-f', '--tail=200', ...restArgs], composeOpts));
        case 'build':
            process.exit(compose(['build', ...restArgs], composeOpts));
        case 'smoke':
            cmdSmoke(port);
            return;
        default:
            die(`unknown command: ${subcommand} (try: up down restart status health logs build smoke)`);
    }
}
