import { runStorageGc, storageStatus } from '../storage-gc.mjs';

/**
 * Observe REST — storage status + G1 GC ([11.storage-db-and-gc.md]).
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} req
 * @param {object} cfg
 * @param {(data: unknown, status?: number) => Response} json
 */
export function handleStorageGcRoute(url, req, cfg, json) {
    const p = url.pathname;
    if (p === '/api/storage/status') {
        return json(storageStatus(cfg));
    }
    if (p === '/api/storage/gc' && req.method === 'POST') {
        const dryRun = url.searchParams.get('dryRun') === '1';
        return json(runStorageGc(cfg, { dryRun }));
    }
    return null;
}
