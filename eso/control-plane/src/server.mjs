import http from 'node:http';
import { handleControlPlaneRequest } from './routes.mjs';

/**
 * Create HTTP server for ESO Control Plane.
 */
export function createControlPlaneServer({ db, authToken = 'secret-token' } = {}) {
    const server = http.createServer((req, res) => {
        handleControlPlaneRequest(req, res, { db, authToken }).catch((err) => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: err.message }));
            }
        });
    });

    return server;
}
