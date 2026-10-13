import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';
import { loadWorkspace, resolveProject } from '@mu/harness-foundation/workspace';

const COMPOSE_FILE = path.join(ESO_ROOT, 'compose.harness.yml');
const DEFAULT_PORT = 8792;

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

function tryDefaultProjectRoot() {
    try {
        const ws = loadWorkspace();
        const p = resolveProject(ws, null);
        return p.rootHost || p.root;
    } catch {
        return null;
    }
}

/**
 * @param {{ repoOptional?: boolean, consumerPath?: string }} opts
 */
function composeEnv(opts = {}) {
    const port = String(process.env.HARNESS_OBSERVE_PORT || DEFAULT_PORT);
    const env = { ...process.env };
    env.HOME = env.HOME || os.homedir();
    env.HARNESS_OBSERVE_PORT = port;
    // No HARNESS_ESO_ROOT: the stack mounts `~/.harness` for product state, so it does not need to
    // know where the checkout is.
    env.HARNESS_AGENT_ROOT = env.HARNESS_AGENT_ROOT || path.join(env.HOME, 'Workspaces');
    env.HARNESS_CURSOR_HOME = env.HARNESS_CURSOR_HOME || path.join(env.HOME, '.cursor');
    env.COMPOSE_PROJECT_NAME = env.COMPOSE_PROJECT_NAME || `harness-observatory-${port}`;

    if (!env.HARNESS_REPO_ROOT && opts.consumerPath) {
        env.HARNESS_REPO_ROOT = path.resolve(opts.consumerPath);
    }
    if (!env.HARNESS_REPO_ROOT) {
        const fromWs = tryDefaultProjectRoot();
        if (fromWs) env.HARNESS_REPO_ROOT = path.resolve(fromWs);
    }
    if (!env.HARNESS_REPO_ROOT) {
        const fromCwd = tryResolveConsumerFromCwd();
        if (fromCwd) env.HARNESS_REPO_ROOT = fromCwd;
    }
    if (!env.HARNESS_REPO_ROOT && opts.repoOptional) {
        env.HARNESS_REPO_ROOT = ESO_ROOT;
    }
    if (!env.HARNESS_REPO_ROOT) {
        die('chưa có dự án — thêm trong http://127.0.0.1:8792/projects hoặc harnessctl observatory up --project <id>');
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
    console.log(`Cursor transcripts: ${env.HARNESS_CURSOR_HOME} → /host-cursor (REQUEST spine)`);
    console.log(`Stop only this stack: HARNESS_OBSERVE_PORT=${port} harnessctl observatory down`);
}

function cmdHealth() {
    const port = process.env.HARNESS_OBSERVE_PORT || DEFAULT_PORT;
    const out = curlJson(`http://127.0.0.1:${port}/health`);
    process.stdout.write(out);
    if (!out.endsWith('\n')) console.log('');
}

function cmdSmoke() {
    const port = process.env.HARNESS_OBSERVE_PORT || DEFAULT_PORT;
    const base = `http://127.0.0.1:${port}`;
    console.log(`==> GET ${base}/health`);
    console.log(curlJson(`${base}/health`));
    console.log(`==> GET ${base}/api/ingest/status`);
    console.log(curlJson(`${base}/api/ingest/status`));
    console.log(`==> POST ${base}/api/ingest/run`);
    console.log(curlJson(`${base}/api/ingest/run`, 'POST'));
    console.log(`==> GET ${base}/api/requests?limit=5`);
    console.log(curlJson(`${base}/api/requests?limit=5`));
}

/**
 * @param {string} subcommand
 * @param {string[]} restArgs
 * @param {{ projectId?: string, consumerPath?: string, port?: number }} [opts]
 */
export function runObservatory(subcommand, restArgs = [], opts = {}) {
    applyWorkspaceEnv();
    requireDocker();

    let consumerPath = opts.consumerPath;
    let port = opts.port;

    if (!consumerPath) {
        try {
            const p = resolveProject(loadWorkspace(), opts.projectId || null);
            consumerPath = p.rootHost || p.root;
            port = port ?? p.port;
        } catch (e) {
            const hasRepo = Boolean(process.env.HARNESS_REPO_ROOT);
            if ((subcommand === 'up' || subcommand === 'restart') && !hasRepo) {
                die(e instanceof Error ? e.message : String(e));
            }
        }
    }

    if (port) process.env.HARNESS_OBSERVE_PORT = String(port);

    const composeOpts = {
        consumerPath,
        repoOptional: subcommand === 'build' || subcommand === 'down' || subcommand === 'status' || subcommand === 'ps' || subcommand === 'logs',
    };

    switch (subcommand) {
        case 'up':
            cmdUp(restArgs, { consumerPath });
            return;
        case 'down':
            process.exit(compose(['down', ...restArgs], { repoOptional: true }));
        case 'restart':
            compose(['down'], { repoOptional: true });
            cmdUp(restArgs, { consumerPath });
            return;
        case 'status':
        case 'ps':
            process.exit(compose(['ps', ...restArgs], { repoOptional: true }));
        case 'health':
            cmdHealth();
            return;
        case 'logs':
            process.exit(compose(['logs', '-f', '--tail=200', ...restArgs], { repoOptional: true }));
        case 'build':
            process.exit(compose(['build', ...restArgs], { repoOptional: true }));
        case 'smoke':
            cmdSmoke();
            return;
        default:
            die(`unknown command: ${subcommand} (try: up down restart status health logs build smoke)`);
    }
}
