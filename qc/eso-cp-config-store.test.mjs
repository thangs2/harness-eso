import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initConfigSchema } from '../eso/control-plane/src/config-schema.ts';
import {
    saveConfig,
    readConfig,
    listConfigEvents,
} from '../eso/control-plane/src/config-store.ts';

function createTestDb() {
    const db = createDbAdapter(':memory:');
    initConfigSchema(db);
    return db;
}

test('ESO-369 (T-04.2): save -> read matches exact hash, version +1 on each save', () => {
    const db = createTestDb();
    const project = 'tenant-test';

    // 1. Initial save (version 1)
    const firstSave = saveConfig(db, {
        project,
        config: { settingA: 'value1', theme: 'dark' },
        operator: 'alice',
    });

    assert.equal(firstSave.version, 1);
    assert.ok(firstSave.hash);
    assert.equal(firstSave.config.settingA, 'value1');

    // Read back version 1
    const readBack1 = readConfig(db, project);
    assert.ok(readBack1);
    assert.equal(readBack1.version, 1);
    assert.equal(readBack1.hash, firstSave.hash);
    assert.equal(readBack1.config.settingA, 'value1');

    // 2. Second save with expectedHash (version 2)
    const secondSave = saveConfig(db, {
        project,
        config: { settingA: 'value2', theme: 'light' },
        expectedHash: firstSave.hash,
        operator: 'bob',
    });

    assert.equal(secondSave.version, 2);
    assert.notEqual(secondSave.hash, firstSave.hash);

    // Read latest (version 2)
    const readBackLatest = readConfig(db, project);
    assert.equal(readBackLatest.version, 2);
    assert.equal(readBackLatest.hash, secondSave.hash);

    // Read specific past version (version 1)
    const readBackPast = readConfig(db, project, 1);
    assert.equal(readBackPast.version, 1);
    assert.equal(readBackPast.hash, firstSave.hash);
    assert.equal(readBackPast.config.settingA, 'value1');
});

test('ESO-369 (T-04.2): stale hash throws STALE_VERSION error', () => {
    const db = createTestDb();
    const project = 'tenant-stale';

    const v1 = saveConfig(db, {
        project,
        config: { key: 'v1' },
    });

    const v2 = saveConfig(db, {
        project,
        config: { key: 'v2' },
        expectedHash: v1.hash,
    });

    // Attempting to save with old hash (v1.hash) while head is v2
    assert.throws(() => {
        saveConfig(db, {
            project,
            config: { key: 'v3_conflict' },
            expectedHash: v1.hash, // STALE!
        });
    }, (err) => {
        assert.equal(err.code, 'STALE_VERSION');
        assert.equal(err.current_hash, v2.hash);
        assert.equal(err.current_version, 2);
        return true;
    });
});

test('ESO-369 (T-04.2): config_event is append-only, UPDATE and DELETE are rejected', () => {
    const db = createTestDb();
    const project = 'tenant-events';

    saveConfig(db, { project, config: { a: 1 } });
    saveConfig(db, { project, config: { a: 2 } });

    const events = listConfigEvents(db, project);
    assert.equal(events.length, 2);
    assert.equal(events[0].version, 1);
    assert.equal(events[1].version, 2);

    // Attempt UPDATE on config_event -> must be rejected by trigger
    assert.throws(() => {
        db.run("UPDATE config_event SET event_type = 'TAMPERED' WHERE version = 1");
    }, /append-only/i);

    // Attempt DELETE on config_event -> must be rejected by trigger
    assert.throws(() => {
        db.run("DELETE FROM config_event WHERE version = 1");
    }, /append-only/i);
});
