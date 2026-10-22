/**
 * v1.3.0 — the two checks that used to pass on a claim instead of a fact.
 *
 * - T3.4 (`file_contains_existing_path`): `docgraph.scope` naming `path:sdlc/00.agent-manifests`
 *   used to PASS even when that directory did not exist, so a consumer scored the Agent Zone tier
 *   for a directory it never had (H6).
 * - T1.3 (`json_value`): nothing checked that `tokenDiet.enabled` was actually on, so a consumer
 *   could pass T1 while injecting every rule eagerly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { diagnoseConsumer } = await import('../packages/harness-cli/src/verify-consumer-cmd.mjs');

function mkTmpConsumer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-t34-path-'));
  fs.writeFileSync(
    path.join(root, 'harness.config.json'),
    JSON.stringify({ project: { id: 't13-fixture' }, server: { port: 8799 } }, null, 2),
  );
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  return root;
}

function writeScope(root, lines) {
  fs.writeFileSync(path.join(root, 'docgraph.scope'), `${lines.join('\n')}\n`);
}

function writePolicy(root, policy) {
  fs.writeFileSync(
    path.join(root, '.harness/decision-policy.json'),
    JSON.stringify(policy, null, 2),
  );
}

function check(root, id) {
  return diagnoseConsumer(root).checks.find((c) => c.id === id);
}

describe('consumer maturity T3.4 — a scope line must name a directory that exists', () => {
  let root;
  before(() => {
    root = mkTmpConsumer();
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FAILS when the Agent Zone is declared but the directory is absent', () => {
    writeScope(root, ['ext:.md', 'path:SDLC/00.agent-manifests', 'path:SDLC']);
    const t34 = check(root, 'T3.4');
    assert.equal(t34.status, 'FAIL');
    assert.match(t34.evidence, /do not exist/);
  });

  it('PASSES once every declared directory exists', () => {
    fs.mkdirSync(path.join(root, 'SDLC', '00.agent-manifests'), { recursive: true });
    assert.equal(check(root, 'T3.4').status, 'PASS');
  });

  it('a missing directory anywhere in the scope fails the check', () => {
    writeScope(root, ['path:SDLC', 'path:no-such-zone/00.agent-manifests']);
    const t34 = check(root, 'T3.4');    assert.equal(t34.status, 'FAIL');
    assert.match(t34.evidence, /no-such-zone\/00\.agent-manifests/);
  });

  it('FAILS when docgraph.scope declares no path at all', () => {
    writeScope(root, ['ext:.md']);
    const t34 = check(root, 'T3.4');
    assert.equal(t34.status, 'FAIL');
    assert.match(t34.evidence, /declares no path:/);
  });

  it('a trailing comment on the line is not part of the directory name', () => {
    writeScope(root, ['path:SDLC/00.agent-manifests # agent zone']);
    assert.equal(check(root, 'T3.4').status, 'PASS');
  });
});

describe('consumer maturity T1.3 — token diet must be switched on', () => {
  let root;
  before(() => {
    root = mkTmpConsumer();
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FAILS when the policy has no tokenDiet block', () => {
    writePolicy(root, { version: 1, eso: { enabled: true } });
    const t13 = check(root, 'T1.3');
    assert.equal(t13.status, 'FAIL');
    assert.match(t13.evidence, /no tokenDiet\.enabled/);
  });

  it('FAILS when tokenDiet is present but disabled', () => {
    writePolicy(root, { version: 1, eso: { enabled: true }, tokenDiet: { enabled: false } });
    const t13 = check(root, 'T1.3');
    assert.equal(t13.status, 'FAIL');
    assert.match(t13.evidence, /expected true/);
  });

  it('PASSES when tokenDiet.enabled is true', () => {
    writePolicy(root, { version: 1, eso: { enabled: true }, tokenDiet: { enabled: true } });
    assert.equal(check(root, 'T1.3').status, 'PASS');
  });

  it('FAILS when the policy file is missing entirely', () => {
    fs.rmSync(path.join(root, '.harness/decision-policy.json'), { force: true });
    assert.equal(check(root, 'T1.3').status, 'FAIL');
  });
});
