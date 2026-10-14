import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = path.join(REPO_ROOT, 'packages/harness-cli/src/cli.mjs');

test('harnessctl token-diet --json returns structured report', () => {
    const raw = execFileSync('node', [CLI_PATH, 'token-diet', REPO_ROOT, '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
    });
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.status, 'string');
    assert.equal(typeof parsed.budget, 'object');
    assert.equal(typeof parsed.trees, 'object');
    assert(parsed.summary.totalRulesCount > 0);
});

test('harnessctl token-diet --tree cursor --json returns cursor-scoped report', () => {
    const raw = execFileSync('node', [CLI_PATH, 'token-diet', REPO_ROOT, '--tree', 'cursor', '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.tree, 'cursor');
    assert(parsed.trees.cursor != null);
    assert.equal(parsed.trees.agents, undefined);
});
