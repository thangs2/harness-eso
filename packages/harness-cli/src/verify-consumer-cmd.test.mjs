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
