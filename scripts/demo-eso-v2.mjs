#!/usr/bin/env bun
/**
 * ESO v2 demo — control plane end-to-end.
 *
 *   bun scripts/demo-eso-v2.mjs --check     # run assertions, exit 0/1
 *   bun scripts/demo-eso-v2.mjs --serve     # seed and keep the server on :8787
 *
 * Everything is written under /tmp. It never touches a real consumer, x79 or
 * comments/artifacts. The only repo write is `npm run build` in
 * eso/control-plane (skip with --no-build).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CP = join(REPO, 'eso/control-plane');
const args = process.argv.slice(2);
const MODE = args.includes('--serve') ? 'serve' : 'check';
const NO_BUILD = args.includes('--no-build');
const PORT = Number((args.find((a) => a.startsWith('--port=')) || '--port=8787').split('=')[1]);
const TOKEN = 'demo-token';
const PROJECT = 'demo';
const NEW_CONFIG = {
  team: { name: 'demo-team', size: 4 },
  sdlc: { root: 'sdlc' },
  policy: { level: 'strict' },
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun scripts/demo-eso-v2.mjs [--check|--serve] [--no-build] [--port=8787]

  --check      run the 11 demo assertions (default), exit 0/1
  --serve      seed a file DB and keep the control plane running on 127.0.0.1:8787
  --no-build   reuse the current eso/control-plane/dist
  --port=N     port for --serve (default 8787)`);
  process.exit(0);
}

function fail(message) {
  console.error(`\n[demo] ${message}`);
  process.exit(1);
}

if (!NO_BUILD) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[demo] building eso/control-plane ...');
  const built = spawnSync(npm, ['run', 'build'], { cwd: CP, stdio: 'inherit' });
  if (built.status !== 0) fail('control-plane build failed');
}
if (!existsSync(join(CP, 'dist/main.js'))) {
  fail('dist/main.js is missing — run without --no-build');
}

// Graph database layer is PostgreSQL ONLY (D-92 / D-93 / ESO-447).
const { createDbAdapter: createGraphDbAdapter } = await import(
  pathToFileURL(join(REPO, 'eso/graph/src/db-adapter.mjs')).href
);
const { initSchema: initGraphSchema } = await import(
  pathToFileURL(join(REPO, 'eso/graph/src/schema.mjs')).href
);
const { createNestFastifyControlPlane } = await import(
  pathToFileURL(join(CP, 'dist/main.js')).href
);
const { initConfigSchema } = await import(
  pathToFileURL(join(CP, 'dist/modules/config/infrastructure/persistence/config.schema.js')).href
);
const { saveConfig } = await import(
  pathToFileURL(
    join(CP, 'dist/modules/config/infrastructure/persistence/repositories/config.repository.js')
  ).href
);
const { ensureEvidenceSchema, recordTurnEvidence } = await import(
  pathToFileURL(join(REPO, 'eso/adapters/src/host-bridge.mjs')).href
);
const { queryEndpointPermissions } = await import(
  pathToFileURL(join(REPO, 'eso/graph/src/q4-permissions.mjs')).href
);
const { querySliceTenantBoundary } = await import(
  pathToFileURL(join(REPO, 'eso/graph/src/q5-tenant.mjs')).href
);

const dbUrl = process.env.ESO_DEMO_DB_URL || process.env.ESO_GRAPH_DB_URL || process.env.GRAPH_DATABASE_URL;
if (!dbUrl) fail('PostgreSQL URL required: set ESO_DEMO_DB_URL (D-93: no SQLite)');
const demoSchema = `eso_demo_${process.pid}_${Date.now()}`;
const schemaAdmin = new Bun.SQL(dbUrl);
await schemaAdmin.unsafe(`CREATE SCHEMA ${demoSchema}`);
await schemaAdmin.close();
const db = createGraphDbAdapter(dbUrl, { schema: demoSchema });
const graphDb = db;
await initGraphSchema(graphDb);
await initConfigSchema(db);
await ensureEvidenceSchema(db);

await saveConfig(db, {
  project: PROJECT,
  config: {
    team: { name: 'demo-team', size: 3 },
    sdlc: { root: 'sdlc' },
    policy: { level: 'strict' },
  },
  operator: 'demo',
});
await recordTurnEvidence({
  db,
  project: PROJECT,
  turnId: 'demo-turn-001',
  level: 'partial',
  mode: 'ask',
  basis: 'verified',
  payload: { work: 'sửa cột tenants', gaps: 2 },
});
await recordTurnEvidence({
  db,
  project: PROJECT,
  turnId: 'demo-turn-002',
  level: 'sufficient',
  mode: 'do',
  basis: 'verified',
  payload: { work: 'thêm endpoint' },
});

const app = await createNestFastifyControlPlane({ db, authToken: TOKEN, authProject: PROJECT });
await app.listen(MODE === 'serve' ? PORT : 0, '127.0.0.1');
const port = MODE === 'serve' ? PORT : app.getHttpAdapter().getInstance().server.address().port;
const base = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function http(path, { method = 'GET', token = TOKEN, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

if (MODE === 'serve') {
  console.log(`\n[demo] control plane: ${base}`);
  console.log(`[demo] token:         ${TOKEN}`);
  console.log(`[demo] project:       ${PROJECT}`);
  console.log('\nOpen:');
  console.log(`  ${base}/work-overview?project=${PROJECT}`);
  console.log('\nCurl:');
  console.log(`  curl -s ${base}/health`);
  console.log(`  curl -s -H "Authorization: Bearer ${TOKEN}" "${base}/config?project=${PROJECT}"`);
  console.log(`  curl -s -H "Authorization: Bearer ${TOKEN}" "${base}/work-overview?project=${PROJECT}"`);
  console.log('\nCtrl-C to stop.\n');
  await new Promise((resolvePromise) => {
    process.once('SIGINT', resolvePromise);
    process.once('SIGTERM', resolvePromise);
  });
  await app.close();
  try { if (typeof db.close === 'function') await db.close(); } catch {}
  console.log('[demo] stopped');
  process.exit(0);
}

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: detail || 'ok' });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
}

let cfgHash = null;
let previewHash = null;

await check('health 200', async () => {
  const r = await http('/health');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.json?.status === 'ok', 'missing status:ok');
  return `200 ${r.text}`;
});

await check('config without token -> 401', async () => {
  const r = await http(`/config?project=${PROJECT}`, { token: null });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  assert(r.json?.code === 'UNAUTHORIZED', 'missing UNAUTHORIZED code');
  return '401 UNAUTHORIZED';
});

await check('config with token matches store', async () => {
  const r = await http(`/config?project=${PROJECT}`);
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.json?.project === PROJECT, 'wrong project');
  assert(r.json?.version === 1, `expected version 1, got ${r.json?.version}`);
  cfgHash = r.json.hash;
  return `v1 hash=${cfgHash}`;
});

await check('save without preview_hash -> 409', async () => {
  const r = await http('/config', { method: 'POST', body: { project: PROJECT, config: NEW_CONFIG } });
  assert(r.status === 409, `expected 409, got ${r.status}`);
  assert(r.json?.code === 'PREVIEW_REQUIRED', 'missing PREVIEW_REQUIRED');
  return '409 PREVIEW_REQUIRED';
});

await check('preview returns hash', async () => {
  const r = await http('/config/preview', {
    method: 'POST',
    body: { project: PROJECT, pendingChange: NEW_CONFIG },
  });
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(typeof r.json?.preview_hash === 'string', 'missing preview_hash');
  previewHash = r.json.preview_hash;
  return `preview_hash=${previewHash}`;
});

await check('save with preview hash -> v2', async () => {
  const r = await http('/config', {
    method: 'POST',
    body: {
      project: PROJECT,
      config: NEW_CONFIG,
      current_hash: cfgHash,
      preview_hash: previewHash,
    },
  });
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.json?.version === 2, `expected version 2, got ${r.json?.version}`);
  assert(r.json?.hash !== cfgHash, 'hash did not change');
  return `v2 hash=${r.json.hash}`;
});

await check('stale current_hash -> 409', async () => {
  const r = await http('/config', {
    method: 'POST',
    body: {
      project: PROJECT,
      config: { team: { size: 5 } },
      current_hash: cfgHash,
      preview_hash: previewHash,
    },
  });
  assert(r.status === 409, `expected 409, got ${r.status}`);
  assert(r.json?.code === 'STALE_VERSION', 'missing STALE_VERSION');
  return '409 STALE_VERSION';
});

await check('S1 page 200 + real work value', async () => {
  const r = await http(`/work-overview?project=${PROJECT}`);
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert((r.headers.get('content-type') || '').includes('text/html'), 'not text/html');
  assert(r.text.includes('sửa cột tenants'), 'work value missing from HTML');
  assert(r.text.includes('data-state="READY"'), 'READY state missing');
  assert(r.text.includes('col-work'), 'work column missing');
  assert(!r.text.includes('ST6_READY'), 'legacy ST6_READY still present');
  return '200 text/html · col-work="sửa cột tenants" · READY';
});

await check('S1 without token -> 401', async () => {
  const r = await http(`/work-overview?project=${PROJECT}`, { token: null });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return '401';
});

await check('Q4 project is mandatory', async () => {
  let code = null;
  try {
    await queryEndpointPermissions({ endpointId: 'GET /demo', db: graphDb });
  } catch (error) {
    code = error.code;
  }
  assert(code === 'INVALID_PROJECT', `expected INVALID_PROJECT, got ${code}`);
  return 'INVALID_PROJECT';
});

await check('Q5 project is mandatory', async () => {
  let code = null;
  try {
    await querySliceTenantBoundary({ sliceId: 'demo', db: graphDb });
  } catch (error) {
    code = error.code;
  }
  assert(code === 'INVALID_PROJECT', `expected INVALID_PROJECT, got ${code}`);
  return 'INVALID_PROJECT';
});

await app.close();
try { if (typeof db.close === 'function') await db.close(); } catch {}

console.log(`\n[demo] ${checks.length} checks`);
let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`PASS  ${c.name} — ${c.detail}`);
  } else {
    failed++;
    console.log(`FAIL  ${c.name} — ${c.detail}`);
  }
}
console.log(`\n[demo] ${checks.length - failed} pass, ${failed} fail`);
if (failed > 0) process.exit(1);
