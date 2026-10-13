import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';

const COMPOSE_FILE = path.join(ESO_ROOT, 'compose.console.yml');
const DEFAULT_PORT = 8791;

function die(msg) {
    console.error(`console: ${msg}`);
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

function composeEnv() {
    const port = String(process.env.HARNESS_CONSOLE_PORT || DEFAULT_PORT);
    const env = { ...process.env };
    env.HOME = env.HOME || os.homedir();
    env.HARNESS_CONSOLE_PORT = port;
    env.HARNESS_AGENT_ROOT = env.HARNESS_AGENT_ROOT || path.join(env.HOME, 'Workspaces');
    const observePort = env.HARNESS_OBSERVE_PORT || '8792';
    env.HARNESS_OBSERVE_HEALTH_BASE =
        env.HARNESS_OBSERVE_HEALTH_BASE || `http://host.docker.internal:${observePort}`;
    env.COMPOSE_PROJECT_NAME = env.COMPOSE_PROJECT_NAME || `harness-console-${port}`;
    return env;
}

function compose(args) {
    const env = composeEnv();
    const result = spawnSync(
        'docker',
        ['compose', '-p', env.COMPOSE_PROJECT_NAME, '-f', COMPOSE_FILE, '--project-directory', ESO_ROOT, ...args],
        { cwd: ESO_ROOT, env, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function curlJson(url) {
    const r = spawnSync('curl', ['-fsS', url], { encoding: 'utf8' });
    if (r.status !== 0) die(`curl failed: ${url}`);
    return r.stdout;
}

function cmdUp(rest) {
    let foreground = false;
    let doBuild = true;
    for (const a of rest) {
        if (a === '-f' || a === '--foreground') foreground = true;
        else if (a === '--no-build') doBuild = false;
        else if (a === '-h' || a === '--help') {
            console.log('console up [--foreground] [--no-build]');
            process.exit(0);
        } else die(`unknown flag: ${a}`);
    }
    const upArgs = ['up'];
    if (doBuild) upArgs.push('--build');
    if (!foreground) upArgs.push('-d');
    const code = compose(upArgs);
    if (code !== 0) process.exit(code);
    const env = composeEnv();
    const port = env.HARNESS_CONSOLE_PORT;
    console.log('');
    console.log(`Console: http://127.0.0.1:${port}/  (compose project: ${env.COMPOSE_PROJECT_NAME})`);
    console.log(
        `Product state: ${env.HARNESS_PRODUCT_STATE_HOST || path.join(env.HOME, '.harness')} → /data/product-state`,
    );
    console.log(`Agent repos: ${env.HARNESS_AGENT_ROOT} → /agent-repos`);
    console.log(`Observe health probe: ${env.HARNESS_OBSERVE_HEALTH_BASE}/health`);
    console.log(`Stop: HARNESS_CONSOLE_PORT=${port} harnessctl console down`);
}

function cmdHealth() {
    const port = process.env.HARNESS_CONSOLE_PORT || DEFAULT_PORT;
    const out = curlJson(`http://127.0.0.1:${port}/health`);
    process.stdout.write(out);
    if (!out.endsWith('\n')) console.log('');
}

/**
 * @param {string} subcommand
 * @param {string[]} restArgs
 */
export function runConsole(subcommand, restArgs = []) {
    applyWorkspaceEnv();
    requireDocker();

    switch (subcommand) {
        case 'up':
            cmdUp(restArgs);
            return;
        case 'down':
            process.exit(compose(['down', ...restArgs]));
        case 'restart':
            compose(['down']);
            cmdUp(restArgs);
            return;
        case 'status':
        case 'ps':
            process.exit(compose(['ps', ...restArgs]));
        case 'health':
            cmdHealth();
            return;
        case 'logs':
            process.exit(compose(['logs', '-f', '--tail=200', ...restArgs]));
        case 'build':
            process.exit(compose(['build', ...restArgs]));
        default:
            die(`unknown command: ${subcommand} (try: up down restart status health logs build)`);
    }
}
