import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findRepoRoot, findConfigPath } from './repo-root.mjs';
import { decisionPolicyFile, harnessDir } from './paths.mjs';
import { loadDecisionPolicy } from './policy-load.mjs';

test('findRepoRoot walks up to harness.config.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-foundation-'));
    const nested = path.join(tmp, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'harness.config.json'), '{}', 'utf8');
    assert.equal(findRepoRoot(nested), tmp);
    assert.equal(findConfigPath(nested), path.join(tmp, 'harness.config.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('paths resolve under .harness', () => {
    const root = '/tmp/repo';
    assert.equal(harnessDir(root), path.join(root, '.harness'));
    assert.equal(decisionPolicyFile(root), path.join(root, '.harness', 'decision-policy.json'));
});

test('loadDecisionPolicy merges file over defaults', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-policy-'));
    const h = path.join(tmp, '.harness');
    fs.mkdirSync(h);
    fs.writeFileSync(
        path.join(h, 'decision-policy.json'),
        JSON.stringify({ eso: { mode: 'hint' } }),
        'utf8',
    );
    const { policy, fromFile } = loadDecisionPolicy({ root: tmp });
    assert.equal(fromFile, true);
    assert.equal(policy.eso.mode, 'hint');
    assert.equal(policy.jev.mode, 'off');
    fs.rmSync(tmp, { recursive: true, force: true });
});
