/**
 * v1.2.0 — T4.3–T4.5 / T5.2–T5.4 factory probes + templates exist.
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

const TEMPLATE_SKILL = path.join(ESO_ROOT, 'profiles/templates/skills/brain-dispatch/SKILL.md');
const TEMPLATE_RULES = [
  'workflow.agentic-factory.mdc',
  'workflow.qc-runtime.mdc',
  'delivery.workflow.mdc',
].map((n) => path.join(ESO_ROOT, 'profiles/templates/rules', n));
const TEMPLATE_VERIFY = path.join(ESO_ROOT, 'profiles/templates/scripts/ci/verify-dual-harness.mjs');

function mkTmpConsumer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-t45-'));
  fs.writeFileSync(
    path.join(root, 'harness.config.json'),
    JSON.stringify({ project: { id: 't45-fixture' }, server: { port: 8799 } }, null, 2),
  );
  return root;
}

describe('consumer maturity v1.2 T4/T5 factory templates', () => {
  it('ships mechanism templates on disk', () => {
    assert.ok(fs.existsSync(TEMPLATE_SKILL), 'brain-dispatch template');
    for (const p of TEMPLATE_RULES) assert.ok(fs.existsSync(p), p);
    assert.ok(fs.existsSync(TEMPLATE_VERIFY), 'verify-dual-harness template');
  });

  it('standard version is 1.2.0', () => {
    const std = JSON.parse(
      fs.readFileSync(path.join(ESO_ROOT, 'profiles/standards/consumer-maturity.v1.json'), 'utf8'),
    );
    assert.equal(std.version, '1.2.0');
    const ids = std.tiers.flatMap((t) => t.checks.map((c) => c.id));
    for (const id of ['T4.3', 'T4.4', 'T4.5', 'T5.2', 'T5.3', 'T5.4']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });
});

describe('consumer maturity v1.2 T4/T5 probes', () => {
  let root;
  before(() => {
    root = mkTmpConsumer();
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FAILS T4.4 / T5.2 when factory surface missing', () => {
    const report = diagnoseConsumer(root);
    assert.equal(report.standardVersion, '1.2.0');
    assert.equal(report.checks.find((c) => c.id === 'T4.4').status, 'FAIL');
    assert.equal(report.checks.find((c) => c.id === 'T5.2').status, 'FAIL');
  });

  it('PASSES when FinESO-shaped factory surface is present', () => {
    fs.mkdirSync(path.join(root, '.cursor/skills/brain-dispatch'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor/skills/demo-engineering-team'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor/skills/brain-dispatch/SKILL.md'), '# brain\n');
    fs.writeFileSync(path.join(root, '.cursor/skills/demo-engineering-team/SKILL.md'), '# eng\n');
    fs.writeFileSync(path.join(root, '.cursor/rules/workflow.agentic-factory.mdc'), '# af\n');
    fs.writeFileSync(path.join(root, '.cursor/rules/workflow.qc-runtime.mdc'), '# qc\n');
    fs.writeFileSync(path.join(root, '.cursor/rules/delivery.workflow.mdc'), '# dw\n');
    fs.writeFileSync(path.join(root, 'scripts/ci/verify-dual-harness.mjs'), '// ok\n');

    const report = diagnoseConsumer(root);
    for (const id of ['T4.3', 'T4.4', 'T4.5', 'T5.2', 'T5.3', 'T5.4']) {
      const c = report.checks.find((x) => x.id === id);
      assert.equal(c.status, 'PASS', `${id} ${c.evidence}`);
    }
  });
});
