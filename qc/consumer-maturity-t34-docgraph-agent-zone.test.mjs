/**
 * T3.4 — docgraph.scope must list Agent Zone path; fix can append when dir exists.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESO_ROOT = path.resolve(HERE, '..');
process.env.HARNESS_ESO_ROOT = ESO_ROOT;

const { diagnoseConsumer } = await import('../packages/harness-cli/src/verify-consumer-cmd.mjs');

function mkTmpConsumer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-t34-'));
  fs.writeFileSync(
    path.join(root, 'harness.config.json'),
    JSON.stringify({ project: { id: 't34-fixture' }, server: { port: 8799 } }, null, 2),
  );
  return root;
}

describe('consumer maturity T3.4 docgraph Agent Zone', () => {
  let root;
  before(() => {
    root = mkTmpConsumer();
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FAILS when docgraph.scope lacks Agent Zone path', () => {
    fs.writeFileSync(
      path.join(root, 'docgraph.scope'),
      ['ext:.md', 'path:SDLC', 'path:AGENTS.md'].join('\n') + '\n',
    );
    fs.mkdirSync(path.join(root, 'SDLC', '00.agent-manifests'), { recursive: true });
    const report = diagnoseConsumer(root);
    const t34 = report.checks.find((c) => c.id === 'T3.4');
    assert.ok(t34, 'T3.4 check present');
    assert.equal(t34.status, 'FAIL');
    assert.equal(report.standardVersion, '1.2.0');
  });

  it('PASSES when path:SDLC/00.agent-manifests is present', () => {
    fs.writeFileSync(
      path.join(root, 'docgraph.scope'),
      [
        'ext:.md',
        'path:SDLC/00.agent-manifests',
        'path:SDLC',
        'path:AGENTS.md',
      ].join('\n') + '\n',
    );
    const report = diagnoseConsumer(root);
    const t34 = report.checks.find((c) => c.id === 'T3.4');
    assert.equal(t34.status, 'PASS');
  });
});
