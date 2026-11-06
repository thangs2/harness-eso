/**
 * Bootstrap for the US-GRAPH-03 acceptance tests.
 *
 * The control-plane is TypeScript with Nest decorators; Bun cannot execute it from source
 * (legacy decorator metadata), so the tests drive the same compiled `dist/main.js` that the
 * full suite builds. When the graph module is not in `dist` yet, build once here so a targeted
 * `bun test qc/acceptance/US-GRAPH-03` is honest instead of silently 404-ing on every route.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_PLANE = path.resolve(HERE, '../../../eso/control-plane');
const DIST_MAIN = path.join(CONTROL_PLANE, 'dist', 'main.js');
const DIST_GRAPH = path.join(CONTROL_PLANE, 'dist', 'modules', 'graph', 'graph.module.js');

let factoryPromise = null;

async function loadFactory() {
    if (!fs.existsSync(DIST_GRAPH)) {
        const build = spawnSync('bun', ['run', 'build'], {
            cwd: CONTROL_PLANE,
            encoding: 'utf8',
        });
        if (build.status !== 0) {
            throw new Error(`control-plane build failed (${build.status}): ${build.stderr || build.stdout}`);
        }
    }
    if (!factoryPromise) {
        factoryPromise = import(pathToFileURL(DIST_MAIN).href);
    }
    return factoryPromise;
}

export async function startGraphApi({ db, project, token = 'graph-acceptance-token' }) {
    const { createNestFastifyControlPlane } = await loadFactory();
    const app = await createNestFastifyControlPlane({ db, authToken: token, authProject: project });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpAdapter().getInstance().server.address();
    return {
        app,
        baseUrl: `http://127.0.0.1:${address.port}`,
        token,
        async close() {
            await app.close();
        },
    };
}

export function postGraph(baseUrl, route, body, options = {}) {
    const headers = {
        Authorization: `Bearer ${options.token || 'graph-acceptance-token'}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    return fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}
