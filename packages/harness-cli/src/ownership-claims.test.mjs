import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWNERSHIP_CLAIMS, explainOwnership } from './ownership-cmd.mjs';

/**
 * The ownership table is the one place the product states **intent** about who owns each policy value.
 * Every claim must cite a file that exists, and every subtree the shipped profile defines must be in the
 * table — because a subtree nobody decided is how `paths.locked` ended up "product-written" in
 * `init report` and "consumer's Source of Truth" in the runbook. Both statements were in this repo; only
 * the operator noticed.
 */
const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ESO_ROOT, 'packages/harness-cli/src/cli.mjs');

test('ownership: every claim cites a file that exists', () => {
    // `profile` is the one claim about a shipped file's *content*, not a documents/ page; it is asserted
    // here so a renamed profile fails this test instead of becoming a dangling citation.
    assert.ok(fs.existsSync(path.join(ESO_ROOT, 'profiles/generic-eso.json')));
    const claim = OWNERSHIP_CLAIMS.find((c) => c.path === 'profile').declaredIn;
    assert.ok(fs.existsSync(path.join(ESO_ROOT, claim)), claim);
    const missing = OWNERSHIP_CLAIMS.map((c) => c.declaredIn)
        .filter((p) => p.startsWith('documents/'))
        .filter((p) => !fs.existsSync(path.join(ESO_ROOT, p)));
    assert.deepEqual(missing, [], `declaredIn paths that do not exist:\n${missing.join('\n')}`);
});

test('ownership: every subtree of the shipped profile has an owner', () => {
    const profile = JSON.parse(fs.readFileSync(path.join(ESO_ROOT, 'profiles/generic-eso.json'), 'utf8'));
    const declared = new Set(OWNERSHIP_CLAIMS.map((c) => c.path));
    const missing = Object.keys(profile).filter((k) => !declared.has(k));
    assert.deepEqual(missing, [], `profile keys with no ownership row: ${missing.join(', ')}`);
});

test('ownership: every row states a side and names the writer', () => {
    for (const c of OWNERSHIP_CLAIMS) {
        assert.ok(['product', 'consumer', 'shared'].includes(c.owner), `${c.path}: owner="${c.owner}"`);
        assert.ok(c.writtenBy && c.writtenBy.length > 3, `${c.path}: missing writtenBy`);
        assert.ok(c.question && c.question.endsWith('?'), `${c.path}: question must be a question`);
    }
});

test('ownership: explain resolves an exact key to its own row, a nested key to its subtree', () => {
    assert.equal(explainOwnership('paths').owner, 'consumer');
    assert.equal(explainOwnership('paths.locked').matched, 'paths');
    assert.equal(explainOwnership('paths.locked').owner, 'consumer');
    assert.equal(explainOwnership('eso.cognition.enforceBrain').matched, 'eso');
    assert.equal(explainOwnership('not.a.key'), null);
});

test('ownership explain: cli prints the row, and says "no product claim" for an undeclared key', () => {
    const known = spawnSync(process.execPath, [CLI, 'ownership', 'explain', 'paths.locked'], { encoding: 'utf8' });
    assert.equal(known.status, 0, known.stderr);
    assert.match(known.stdout, /paths\s+→ consumer/);
    assert.match(known.stdout, /08\.provisioning-consumers\.md/);

    const unknown = spawnSync(process.execPath, [CLI, 'ownership', 'explain', 'zebra'], { encoding: 'utf8' });
    assert.equal(unknown.status, 0);
    assert.match(unknown.stdout, /no product claim/);
});

test('ownership explain: no key is a usage error, not an empty answer', () => {
    const r = spawnSync(process.execPath, [CLI, 'ownership', 'explain'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /known:/);
});
