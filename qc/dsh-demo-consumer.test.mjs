import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeDemoConsumer } from '../scripts/make-dsh-demo-consumer.mjs';

test('the demo consumer declares itself, and declares both gate paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-demo-'));
    const root = path.join(dir, 'consumer');
    const result = makeDemoConsumer({ out: root });

    assert.equal(result.root, root);
    assert.ok(fs.existsSync(path.join(root, 'harness.config.json')));
    assert.ok(fs.existsSync(path.join(root, '.harness/decision-policy.json')));
    assert.ok(fs.existsSync(path.join(root, 'db/migrations/001_drop.sql')));

    const policy = JSON.parse(fs.readFileSync(path.join(root, '.harness/decision-policy.json'), 'utf8'));
    assert.deepEqual(policy.paths.locked, ['secrets/']);
    assert.deepEqual(policy.paths.gated, ['AGENTS.md']);
    assert.deepEqual(policy.eso.checks.migration.files, ['db/migrations/001_drop.sql']);

    // The prompt gate only fires on a real finding, so the fixture must actually contain one.
    assert.match(fs.readFileSync(path.join(root, 'db/migrations/001_drop.sql'), 'utf8'), /drop\s+table/i);
});

test('a non-empty target is refused instead of overwriting someone else directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-demo-busy-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'do not touch\n');
    assert.throws(() => makeDemoConsumer({ out: dir }), /not empty/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'do not touch\n');
});
