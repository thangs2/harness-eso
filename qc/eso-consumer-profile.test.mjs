import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from './helpers/test-pg-db.mjs';
import { createNestFastifyControlPlane } from '../eso/control-plane/dist/main.js';
import { ConsumerService } from '../eso/control-plane/dist/modules/consumers/application/services/consumer.service.js';

const TOKEN = 'consumer-test-token';
const BASE_PROFILE = {
  id: 'acme',
  name: 'Acme Platform',
  root: '/tmp/acme',
  repoUrl: 'git@example.com:acme/platform.git',
  hostMode: 'dual-ide',
  observePort: 8792,
  sdlcRoot: 'sdlc',
  profile: { recipe: 'pro', hostProfile: 'cursor-superset', description: 'Full external evidence' },
  integration: { jevMode: 'off', consent: true, hostPack: 'full', memoryAdapter: 'none' },
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

test('Consumer profile: consumer profile create/list/get/update persists versions', async () => {
  const pg = await createTestPgDb();
  const db = pg.db;
  const app = await createNestFastifyControlPlane({ db, authToken: TOKEN, authProject: 'acme' });
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

    const plan = await fetch(`${base}/api/v1/consumers/plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...BASE_PROFILE, id: 'acme' }),
    });
    assert.equal(plan.status, 200);
    const planned = await plan.json();
    assert.equal(planned.files.some((f) => f.relative === 'harness.config.json'), true);
    assert.equal(planned.files.some((f) => f.relative === '.harness/decision-policy.json'), true);
    assert.equal(Array.isArray(planned.warnings), true);

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
      body: JSON.stringify({ ...BASE_PROFILE, id: 'acme', zones: [{ name: 'human', path: 'sdlc' }] }),
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

    const old = await db.get('SELECT status FROM sdlc_profile WHERE project = ? AND version = ?', ['acme', 1]);
    assert.equal(old.status, 'superseded');
    const latest = await db.get('SELECT status, version FROM sdlc_profile WHERE project = ? ORDER BY version DESC', ['acme']);
    assert.equal(latest.version, 2);
    assert.equal(latest.status, 'current');

    const get = await fetch(`${base}/api/v1/consumers/acme`, { headers });
    assert.equal(get.status, 200);
    assert.equal((await get.json()).version, 2);
  } finally {
    await app.close();
    await pg.cleanup();
  }
});

test('ConsumerService: direct service calls enforce fail-closed tenant boundary (defense-in-depth)', async () => {
  const pg = await createTestPgDb();
  const db = pg.db;
  const app = await createNestFastifyControlPlane({ db, authToken: TOKEN, authProject: 'proj-alpha' });
  const service = app.get(ConsumerService);

  const profileB = { ...BASE_PROFILE, id: 'proj-beta' };

  try {
    // 1. service.list(undefined) => 403 AUTH_PROJECT_MISSING
    await assert.rejects(
      async () => await service.list(undefined),
      (err) => err.status === 403 && (err.response?.code === 'AUTH_PROJECT_MISSING' || /AUTH_PROJECT_MISSING/.test(JSON.stringify(err)))
    );

    // 2. service.create(profileB, undefined) => 403 AUTH_PROJECT_MISSING
    await assert.rejects(
      async () => await service.create(profileB, undefined),
      (err) => err.status === 403 && (err.response?.code === 'AUTH_PROJECT_MISSING' || /AUTH_PROJECT_MISSING/.test(JSON.stringify(err)))
    );

    // 3. service.plan(profileB, undefined) => 403 AUTH_PROJECT_MISSING
    await assert.rejects(
      async () => service.plan(profileB, undefined),
      (err) => err.status === 403 && (err.response?.code === 'AUTH_PROJECT_MISSING' || /AUTH_PROJECT_MISSING/.test(JSON.stringify(err)))
    );

    // 4. direct service missing id -> 400 before scope
    await assert.rejects(
      async () => await service.create({ ...BASE_PROFILE, id: '' }, 'proj-alpha'),
      (err) => err.status === 400 && err.response?.code === 'CONSUMER_ID_REQUIRED'
    );
    await assert.rejects(
      async () => service.plan({ ...BASE_PROFILE, id: undefined }, 'proj-alpha'),
      (err) => err.status === 400 && err.response?.code === 'CONSUMER_ID_REQUIRED'
    );

    // 5. service.get(projectB, projectA) => 403 OUT_OF_SCOPE
    await assert.rejects(
      async () => await service.get('proj-beta', 'proj-alpha'),
      (err) => err.status === 403 && (err.response?.code === 'OUT_OF_SCOPE' || /OUT_OF_SCOPE/.test(JSON.stringify(err)))
    );

    // 6. service.update(projectB, dto, projectA) => 403 OUT_OF_SCOPE
    await assert.rejects(
      async () => await service.update('proj-beta', profileB, 'proj-alpha'),
      (err) => err.status === 403 && (err.response?.code === 'OUT_OF_SCOPE' || /OUT_OF_SCOPE/.test(JSON.stringify(err)))
    );
  } finally {
    await app.close();
    await pg.cleanup();
  }
});
