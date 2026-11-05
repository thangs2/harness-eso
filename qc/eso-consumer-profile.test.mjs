import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { createNestFastifyControlPlane } from '../eso/control-plane/dist/main.js';

const TOKEN = 'consumer-test-token';
const BASE_PROFILE = {
  id: 'acme',
  name: 'Acme Platform',
  root: '/tmp/acme',
  repoUrl: 'git@example.com:acme/platform.git',
  hostMode: 'dual-ide',
  observePort: 8792,
  sdlcRoot: 'sdlc',
  zones: [
    { name: 'human', path: 'sdlc', headerProfile: 'human-v1' },
    { name: 'agent', path: '.agents', headerProfile: 'agent-v1' },
  ],
  headerProfile: 'standard-v1',
  presetVersion: '2026-11',
  tools: { jira: true, notion: false, plan: true },
  team: { roles: ['lead', 'build', 'verify', 'audit'] },
  gates: { design: true, build: true, verify: true, release: true },
  sources: { docgraph: true, codegraph: true, memory: false },
  protectedPaths: ['AGENTS.md', '.cursor/rules/', 'sdlc/'],
};

test('ESO-390: consumer profile create/list/get/update persists versions', async () => {
  const db = createDbAdapter(':memory:');
  const app = await createNestFastifyControlPlane({ db, authToken: TOKEN });
  await app.listen(0, '127.0.0.1');
  const port = app.getHttpAdapter().getInstance().server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    const unauth = await fetch(`${base}/api/v1/consumers`);
    assert.equal(unauth.status, 401);

    const create = await fetch(`${base}/api/v1/consumers`, {
      method: 'POST',
      headers,
      body: JSON.stringify(BASE_PROFILE),
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal(created.id, 'acme');
    assert.equal(created.version, 1);

    const list = await fetch(`${base}/api/v1/consumers`, { headers });
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, 'acme');
    assert.equal(listed.items[0].version, 1);

    const duplicate = await fetch(`${base}/api/v1/consumers`, {
      method: 'POST',
      headers,
      body: JSON.stringify(BASE_PROFILE),
    });
    assert.equal(duplicate.status, 409);

    const missingZone = await fetch(`${base}/api/v1/consumers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...BASE_PROFILE, id: 'bad', zones: [{ name: 'human', path: 'sdlc' }] }),
    });
    assert.equal(missingZone.status, 400);

    const update = await fetch(`${base}/api/v1/consumers/acme`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...BASE_PROFILE,
        name: 'Acme Platform v2',
        team: { roles: ['lead', 'build', 'verify'] },
      }),
    });
    assert.equal(update.status, 200);
    const updated = await update.json();
    assert.equal(updated.version, 2);
    assert.equal(updated.name, 'Acme Platform v2');

    const old = db.get('SELECT status FROM sdlc_profile WHERE project = ? AND version = ?', ['acme', 1]);
    assert.equal(old.status, 'superseded');
    const latest = db.get('SELECT status, version FROM sdlc_profile WHERE project = ? ORDER BY version DESC', ['acme']);
    assert.equal(latest.version, 2);
    assert.equal(latest.status, 'current');

    const get = await fetch(`${base}/api/v1/consumers/acme`, { headers });
    assert.equal(get.status, 200);
    assert.equal((await get.json()).version, 2);
  } finally {
    await app.close();
    try { db.close(); } catch {}
  }
});
