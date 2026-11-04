import { readConfig, saveConfig } from './config-store.mjs';
import { previewConfigChange } from './config-mgr.mjs';

/**
 * Handle incoming HTTP request for ESO Control Plane.
 */
export async function handleControlPlaneRequest(req, res, { db, authToken = 'secret-token' } = {}) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    // CORS & JSON content-type
    res.setHeader('Content-Type', 'application/json');

    // 1. Unauthenticated health endpoint
    if (method === 'GET' && pathname === '/health') {
        try {
            if (db && typeof db.get === 'function') {
                db.get('SELECT 1');
            } else if (db && typeof db.all === 'function') {
                db.all('SELECT 1');
            } else if (db && typeof db.prepare === 'function') {
                db.prepare('SELECT 1').get();
            } else {
                throw new Error('Database instance unavailable');
            }
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok', service: 'eso-control-plane', timestamp: new Date().toISOString() }));
            return;
        } catch (err) {
            res.writeHead(503);
            res.end(JSON.stringify({ status: 'unhealthy', error: 'STORE_UNAVAILABLE', message: err.message }));
            return;
        }
    }

    // 2. Authentication check for protected endpoints
    const authHeader = req.headers['authorization'] || req.headers['x-eso-token'];
    let providedToken = null;
    if (authHeader) {
        providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    }

    if (!providedToken || (authToken && providedToken !== authToken)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Token required' }));
        return;
    }

    // Parse body for POST / PUT
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
        try {
            const rawBody = await new Promise((resolve, reject) => {
                let data = '';
                req.on('data', (chunk) => { data += chunk; });
                req.on('end', () => resolve(data));
                req.on('error', reject);
            });
            body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'INVALID_JSON', message: 'Malformed JSON payload' }));
            return;
        }
    }

    // 3. GET /config
    if (method === 'GET' && pathname === '/config') {
        const project = url.searchParams.get('project');
        const version = url.searchParams.get('version');
        if (!project) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'PROJECT_REQUIRED', message: 'Query param project is required' }));
            return;
        }

        const record = readConfig(db, project, version ? Number(version) : null);
        if (!record) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'CONFIG_NOT_FOUND', message: `No config found for project "${project}"` }));
            return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, ...record }));
        return;
    }

    // 4. POST /config/preview
    if (method === 'POST' && pathname === '/config/preview') {
        const { project, pendingChange } = body;
        if (!project || !pendingChange) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'INVALID_PREVIEW_PAYLOAD', message: 'project and pendingChange required' }));
            return;
        }

        const current = readConfig(db, project);
        const currentConfig = current ? current.config : { version: 1 };
        const currentHash = current ? current.hash : null;
        const preview = previewConfigChange({
            project,
            currentConfig,
            pendingChange,
        });

        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            current_hash: currentHash,
            preview_hash: preview.preview_hash,
            diff: { current: currentConfig, pending: pendingChange },
            ...preview,
        }));
        return;
    }

    // 5. POST /config
    if (method === 'POST' && pathname === '/config') {
        const { project, config, current_hash, currentHash, preview_hash, previewHash, operator } = body;
        const pHash = preview_hash || previewHash;
        const cHash = current_hash !== undefined ? current_hash : (currentHash !== undefined ? currentHash : null);

        // DoD: POST /config thiếu preview hash -> 409
        if (!pHash) {
            res.writeHead(409);
            res.end(JSON.stringify({
                error: 'PREVIEW_REQUIRED',
                code: 'PREVIEW_REQUIRED',
                message: 'POST /config thiếu preview hash (phải preview trước khi save)',
            }));
            return;
        }

        try {
            const saved = saveConfig(db, {
                project,
                config,
                expectedHash: cHash,
                operator: operator || 'operator',
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...saved }));
            return;
        } catch (err) {
            if (err.code === 'STALE_VERSION') {
                res.writeHead(409);
                res.end(JSON.stringify({
                    error: 'STALE_VERSION',
                    code: 'STALE_VERSION',
                    message: err.message,
                    current_hash: err.current_hash,
                }));
                return;
            }
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'SAVE_FAILED', message: err.message }));
            return;
        }
    }

    // 404 for unknown endpoints
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Route ${method} ${pathname} not found` }));
}
