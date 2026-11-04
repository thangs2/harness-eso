import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('assertWithinConsumer throws UNKNOWN_CONSUMER when consumer directory does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), `non-existent-consumer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    assert.throws(
        () => assertWithinConsumer(nonExistent, path.join(nonExistent, '.harness', 'config.json')),
        (err) => err.code === 'UNKNOWN_CONSUMER'
    );
});

test('symlink .harness pointing outside consumer directory throws OUTSIDE_CONSUMER', () => {
    const { dir: consumerDir, cleanup: cleanupConsumer } = createTempConsumer();
    const { dir: outsideDir, cleanup: cleanupOutside } = createTempConsumer();

    try {
        const symlinkHarness = path.join(consumerDir, '.harness');
        fs.symlinkSync(outsideDir, symlinkHarness);

        // assertWithinConsumer directly
        assert.throws(
            () => assertWithinConsumer(consumerDir, path.join(symlinkHarness, 'config.json')),
            (err) => err.code === 'OUTSIDE_CONSUMER'
        );

        // initProfileV2 fails without writing files outside
        assert.throws(
            () => initProfileV2(consumerDir, { projectId: 'test-symlink' }),
            (err) => err.code === 'OUTSIDE_CONSUMER'
        );

        assert.equal(fs.existsSync(path.join(outsideDir, 'config.json')), false);
        assert.equal(fs.existsSync(path.join(outsideDir, 'state.json')), false);
    } finally {
        cleanupConsumer();
        cleanupOutside();
    }
});

test('dry-run writes 0 files to disk and returns dryRun: true', () => {
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

test('cli: unknown consumer exits with code 2 and writes 0 files', () => {
    const nonExistent = path.join(os.tmpdir(), `khong-ton-tai-${Date.now()}`);
    const cliPath = path.resolve('eso/cli/cli.mjs');
    const res = spawnSync(process.execPath, [cliPath, 'init', 'profile', nonExistent, '--dry-run'], {
        encoding: 'utf8',
    });
    assert.equal(res.status, 2);
    assert.equal(fs.existsSync(nonExistent), false);
});
