import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStaticHandler } from '../packages/harness-observe-server/src/observe-static.mjs';

/**
 * The static handler has two jobs that pull in opposite directions:
 *
 *   - a client route (`/requests/<id>`, `/projects/x79/config`) must return the SPA shell, because the
 *     router lives in the browser and a hard refresh on a deep link has to work;
 *   - an API path that does not exist must be a **404**, because a `200 text/html` answer to an API
 *     call reads as success and hides the mistake.
 *
 * The ordering is what makes this subtle. The SPA rewrite happens when the path has no dot, before any
 * existence check — so a guard placed after the rewrite never runs for `/v1/whatever`. That is how a
 * deleted route (F27) kept looking alive.
 */
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-static-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>SPA</title>');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    return root;
}

test('a client route returns the SPA shell', () => {
    const serve = createStaticHandler(fixture());
    for (const p of ['/', '/requests', '/requests/abc:1', '/projects/x79/config', '/deep/link']) {
        const res = serve(p);
        assert.ok(res, `${p} should resolve`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
    }
});

test('a real static asset is served as-is', () => {
    const serve = createStaticHandler(fixture());
    const res = serve('/assets/app.js');
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
});

test('an unknown API path is a 404, not the SPA shell', () => {
    // The regression: these all answered `200 text/html` because the dotless-path rewrite ran first.
    const serve = createStaticHandler(fixture());
    for (const p of ['/v1/guard/write', '/v1/nope', '/api/nope', '/events/nope']) {
        assert.equal(serve(p), null, `${p} must not resolve to the SPA`);
    }
});

test('a real file under an API prefix is still served', () => {
    // The guard must not be a blanket "reject /v1" — a genuine static file there keeps working.
    const root = fixture();
    fs.mkdirSync(path.join(root, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v1', 'spec.json'), '{"ok":true}');
    const serve = createStaticHandler(root);
    const res = serve('/v1/spec.json');
    assert.ok(res, 'an existing file under /v1 must still be served');
    assert.equal(res.status, 200);
});

test('path traversal is refused', () => {
    const serve = createStaticHandler(fixture());
    assert.equal(serve('/../../etc/passwd'), null);
    assert.equal(serve('/v1/../../../etc/passwd'), null);
});
