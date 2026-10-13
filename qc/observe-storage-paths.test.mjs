import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveObserveStoragePaths } from '../packages/harness-observe-server/src/observe-config.mjs';

function withEnv(overrides, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(overrides)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('the default data root is outside the consumer repo', async () => {
    // This used to fall back to `<consumer>/.harness/harness.db`, which is how a 38 MB database
    // (plus -wal/-shm) ended up in the consumer's working tree and produced two divergent copies
    // of the same project. A relative `storage.sqlite.path` is now ignored: config must not be able
    // to place a database in a git working tree by accident.
    const { defaultObserveDataRoot } = await import(
        '../packages/harness-observe-server/src/observe-config.mjs'
    );
    withEnv({ HARNESS_DATA_ROOT: undefined, HARNESS_SQLITE_PATH: undefined }, () => {
        const root = '/data/repo';
        const { dataDir, storageTarget } = resolveObserveStoragePaths(root, 'x79', {
            sqlite: { path: '.harness/harness.db' },
        });
        assert.equal(dataDir, path.join(defaultObserveDataRoot(), 'x79'));
        assert.equal(storageTarget, path.join(defaultObserveDataRoot(), 'x79', 'harness.db'));
        assert.ok(!storageTarget.startsWith(root), 'must not resolve inside the consumer repo');
    });
});

test('an absolute storage.sqlite.path is honoured as the operator state it is', () => {
    withEnv({ HARNESS_DATA_ROOT: undefined, HARNESS_SQLITE_PATH: undefined }, () => {
        const { dataDir, storageTarget } = resolveObserveStoragePaths('/data/repo', 'x79', {
            sqlite: { path: '/mnt/big/x79.db' },
        });
        assert.equal(storageTarget, '/mnt/big/x79.db');
        assert.equal(dataDir, '/mnt/big');
    });
});

test('resolveObserveStoragePaths uses HARNESS_DATA_ROOT per project id', () => {
    withEnv({ HARNESS_DATA_ROOT: '/data/observe', HARNESS_SQLITE_PATH: undefined }, () => {
        const { dataDir, storageTarget } = resolveObserveStoragePaths('/data/repo', 'x79', {});
        assert.equal(dataDir, '/data/observe/x79');
        assert.equal(storageTarget, '/data/observe/x79/harness.db');
    });
});

test('resolveObserveStoragePaths honors HARNESS_SQLITE_PATH', () => {
    withEnv(
        { HARNESS_SQLITE_PATH: '/data/observe/custom/db.sqlite', HARNESS_DATA_ROOT: '/data/observe' },
        () => {
            const { dataDir, storageTarget } = resolveObserveStoragePaths('/data/repo', 'x79', {});
            assert.equal(storageTarget, '/data/observe/custom/db.sqlite');
            assert.equal(dataDir, '/data/observe');
        },
    );
});
