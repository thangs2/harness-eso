import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initProfileV2, assertWithinConsumer } from './init-profile.mjs';

function createTempConsumer() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-v2-consumer-'));
    return {
        dir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

test('assertWithinConsumer throws when path is outside consumer directory', () => {
    const { dir, cleanup } = createTempConsumer();
    try {
        assert.doesNotThrow(() => assertWithinConsumer(dir, path.join(dir, '.harness', 'config.json')));
        assert.throws(() => assertWithinConsumer(dir, path.join(dir, '..', 'escape.json')), /ACCESS_DENIED/);
    } finally {
        cleanup();
    }
});

test('dry-run writes 0 files to disk and returns dryRun: true, changed: false', () => {
    const { dir, cleanup } = createTempConsumer();
    try {
        const res = initProfileV2(dir, { dryRun: true, projectId: 'test-sandbox' });
        assert.equal(res.ok, true);
        assert.equal(res.dryRun, true);
        assert.equal(fs.existsSync(path.join(dir, '.harness')), false);
        assert.equal(res.files.length, 2);
    } finally {
        cleanup();
    }
});

test('idempotency: first run changed: true, second run changed: false', () => {
    const { dir, cleanup } = createTempConsumer();
    try {
        const first = initProfileV2(dir, { projectId: 'test-sandbox' });
        assert.equal(first.ok, true);
        assert.equal(first.changed, true);
        assert.equal(fs.existsSync(path.join(dir, '.harness', 'config.json')), true);
        assert.equal(fs.existsSync(path.join(dir, '.harness', 'state.json')), true);

        const second = initProfileV2(dir, { projectId: 'test-sandbox' });
        assert.equal(second.ok, true);
        assert.equal(second.changed, false);
    } finally {
        cleanup();
    }
});
