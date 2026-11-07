/**
 * The liveness probe's accept/reject contract.
 *
 * All cases use an injected `fetchImpl`; no network and no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeLivez } from '../src/livez.mjs';

function respond(status, body, { jsonThrows = false } = {}) {
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        async json() {
            if (jsonThrows) throw new SyntaxError('not json');
            return body;
        },
    });
}

test('accepts the real health payload', async () => {
    const result = await probeLivez('http://localhost:3211', {
        fetchImpl: respond(200, { service: 'agentmemory', status: 'ok' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.body.service, 'agentmemory');
});

test('rejects a 200 from the wrong service', async () => {
    const result = await probeLivez('http://localhost:3211', {
        fetchImpl: respond(200, { service: 'something-else', status: 'ok' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unexpected (service|livez payload)/);
});

test('rejects a 200 with no JSON body (port reuse / proxy page)', async () => {
    const result = await probeLivez('http://localhost:3211', {
        fetchImpl: respond(200, null, { jsonThrows: true }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not return JSON/);
});

test('rejects a non-ok HTTP status', async () => {
    const result = await probeLivez('http://localhost:3211', { fetchImpl: respond(503, {}) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
});

test('reports a timeout as a readable reason', async () => {
    const fetchImpl = (_url, { signal }) =>
        new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        });
    const result = await probeLivez('http://localhost:3211', { fetchImpl, timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out after 50ms/);
});

test('reports a network failure as a readable reason', async () => {
    const result = await probeLivez('http://localhost:3211', {
        fetchImpl: async () => {
            const error = new Error('fetch failed');
            error.cause = { code: 'ECONNREFUSED' };
            throw error;
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ECONNREFUSED');
});
