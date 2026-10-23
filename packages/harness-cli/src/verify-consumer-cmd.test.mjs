import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnoseConsumer } from './verify-consumer-cmd.mjs';

describe('diagnoseConsumer', () => {
  test('empty temp dir fails CRITICAL T0 and is ok=false', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-verify-'));
    const report = diagnoseConsumer(root);
    expect(report.ok).toBe(false);
    expect(report.summary.criticalFail).toBeGreaterThan(0);
    expect(report.summary.tierReached).toBe('NONE');
    const t01 = report.checks.find((c) => c.id === 'T0.1');
    expect(t01?.status).toBe('FAIL');
  });
});

/**
 * P-03: `dir_exists` said the index was present and nothing said it was current, so every audited
 * consumer passed T2.4 on an index days behind its rule files.
 */
describe('T2.5 index freshness', () => {
  const standard = {
    id: 'test',
    version: '1',
    tiers: [
      {
        id: 'T2',
        name: 'recon',
        checks: [
          { id: 'T2.4', title: 'index dir', severity: 'INFO', probe: { type: 'dir_exists', path: '.docgraph' } },
          { id: 'T2.5', title: 'index fresh', severity: 'INFO', probe: { type: 'index_fresh', path: '.docgraph' }, remediation: { action: 'index-rebuild' } },
        ],
      },
    ],
  };
  const std = { path: 'inline', data: standard };
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eso-fresh-'));
  const run = (root) => diagnoseConsumer(root, { standard: std }).checks.find((c) => c.id === 'T2.5');

  test('a missing index fails the freshness check too', () => {
    const root = mk();
    expect(run(root).status).toBe('FAIL');
    expect(run(root).evidence).toContain('missing dir .docgraph');
  });

  test('an index older than the newest rule is reported stale, with the remedy', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, '.docgraph'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
    const old = new Date('2026-10-01T00:00:00Z');
    fs.writeFileSync(path.join(root, '.docgraph', 'docgraph.json'), '{}');
    fs.utimesSync(path.join(root, '.docgraph', 'docgraph.json'), old, old);
    fs.writeFileSync(path.join(root, '.cursor', 'rules', 'core.gate.mdc'), '# law');
    const newer = new Date('2026-10-20T00:00:00Z');
    fs.utimesSync(path.join(root, '.cursor', 'rules', 'core.gate.mdc'), newer, newer);

    const c = run(root);
    expect(c.status).toBe('FAIL');
    expect(c.evidence).toContain('19 day(s) behind');
    expect(c.remediation?.action).toBe('index-rebuild');
  });

  test('a source file with no extension (AGENTS.md counts, directory mtimes do not) still passes when current', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, '.docgraph'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# law');
    const older = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(path.join(root, 'AGENTS.md'), older, older);
    const newer = new Date('2026-10-20T00:00:00Z');
    fs.writeFileSync(path.join(root, '.docgraph', 'docgraph.json'), '{}');
    fs.utimesSync(path.join(root, '.docgraph', 'docgraph.json'), newer, newer);

    expect(run(root).status).toBe('PASS');
  });
});
