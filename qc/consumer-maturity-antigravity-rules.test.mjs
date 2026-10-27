/**
 * v1.3.0 — T4.6 / T4.7: the standard must be able to see `.agents/rules/`.
 *
 * fineso 2026-10-24 (F-04): `ensureConsumerRules` wrote `.mdc` into `.agents/rules/` and every rule
 * probe in this standard named `.cursor/`, so `verify consumer` reported a clean tree while the
 * consumer's own INV-05 gate failed on 7 files. A check that provisions a tree must check that tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESO_ROOT = path.resolve(HERE, '..');
process.env.HARNESS_ESO_ROOT = ESO_ROOT;

const { diagnoseConsumer } = await import('../packages/harness-cli/src/verify-consumer-cmd.mjs');

const RULES_TEMPLATES = path.join(ESO_ROOT, 'profiles/templates/rules');

function mkConsumer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-agents-rules-'));
  fs.writeFileSync(
    path.join(root, 'harness.config.json'),
    JSON.stringify({ project: { id: 'agents-rules-fixture' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, '.agents/rules'), { recursive: true });
  return root;
}

const status = (report, id) => report.checks.find((c) => c.id === id)?.status;

describe('consumer maturity T4.6 / T4.7 — Antigravity tree is inspected', () => {
  const roots = [];
  after(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  it('PASSES on a clean tree (no .mdc, own .md content)', () => {
    const root = mkConsumer();
    roots.push(root);
    fs.copyFileSync(
      path.join(RULES_TEMPLATES, 'core.pipeline-gate.md'),
      path.join(root, '.agents/rules/core.pipeline-gate.md'),
    );

    const report = diagnoseConsumer(root);
    assert.equal(status(report, 'T4.6'), 'PASS', 'no .mdc under .agents/rules');
    assert.equal(status(report, 'T4.7'), 'PASS', 'real .md rule');
  });

  it('FAILS T4.6 when the pre-fix defect is present (.mdc in .agents/rules)', () => {
    const root = mkConsumer();
    roots.push(root);
    // exactly what ensureConsumerRules used to produce: the .mdc, and its bytes under a .md name
    const mdc = fs.readFileSync(path.join(RULES_TEMPLATES, 'core.pipeline-gate.mdc'), 'utf8');
    fs.writeFileSync(path.join(root, '.agents/rules/core.pipeline-gate.mdc'), mdc);
    fs.writeFileSync(path.join(root, '.agents/rules/core.pipeline-gate.md'), mdc);

    const report = diagnoseConsumer(root);
    const ext = report.checks.find((c) => c.id === 'T4.6');
    assert.equal(ext.status, 'FAIL', 'a .mdc under .agents/rules must be visible');
    assert.match(ext.evidence, /core\.pipeline-gate\.mdc/, 'the offending file is named');
    assert.equal(status(report, 'T4.7'), 'FAIL', 'the .md is the .mdc by another name');
    assert.match(
      report.checks.find((c) => c.id === 'T4.7').evidence,
      /byte copy/,
      'content defect is distinguishable from an extension defect',
    );
  });

  it('FAILS T4.7 when the .md carries Cursor globs even if it is not a byte copy', () => {
    const root = mkConsumer();
    roots.push(root);
    fs.writeFileSync(
      path.join(root, '.agents/rules/core.pipeline-gate.md'),
      '---\ndescription: x\nalwaysApply: false\nglobs: "src/**/*"\n---\n\n# Rule\n\nbody\n',
    );

    const report = diagnoseConsumer(root);
    assert.equal(status(report, 'T4.6'), 'PASS');
    assert.equal(status(report, 'T4.7'), 'FAIL');
    assert.match(report.checks.find((c) => c.id === 'T4.7').evidence, /Cursor globs/);
  });

  it('does not demote the tier: T4.6 / T4.7 are INFO', () => {
    const root = mkConsumer();
    roots.push(root);
    fs.copyFileSync(
      path.join(RULES_TEMPLATES, 'core.pipeline-gate.mdc'),
      path.join(root, '.agents/rules/core.pipeline-gate.mdc'),
    );

    const withViolation = diagnoseConsumer(root);
    const clean = mkConsumer();
    roots.push(clean);
    const cleanReport = diagnoseConsumer(clean);

    // the violated tree must not reach a *lower* tier than an otherwise-identical clean tree
    assert.equal(withViolation.summary.tierReached, cleanReport.summary.tierReached);
    for (const id of ['T4.6', 'T4.7']) {
      const c = withViolation.checks.find((x) => x.id === id);
      assert.equal(c.severity, 'INFO', `${id} must stay INFO so a visible defect cannot silently demote a consumer`);
    }
  });

  it('ships both checks in the standard', () => {
    const std = JSON.parse(fs.readFileSync(path.join(ESO_ROOT, 'profiles/standards/consumer-maturity.v1.json'), 'utf8'));
    const byId = new Map(std.tiers.flatMap((t) => t.checks.map((c) => [c.id, c])));
    assert.ok(byId.has('T4.6'));
    assert.ok(byId.has('T4.7'));
    // every path probe in the old standard named .cursor/ — this is the regression
    const probesAgentsRules = [...byId.values()].some((c) => /\.agents\/rules/.test(JSON.stringify(c.probe)));
    assert.ok(probesAgentsRules, 'at least one check must probe .agents/rules');
  });
});
