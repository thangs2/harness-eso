import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initConfigSchema } from '../eso/control-plane/src/modules/config/infrastructure/persistence/config.schema.ts';
import {
    saveConfig,
    readConfig,
    listConfigEvents,
} from '../eso/control-plane/src/modules/config/infrastructure/persistence/repositories/config.repository.ts';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

async function createTestDb() {
    const pg = await createTestPgDb();
    await initConfigSchema(pg.db);
    return pg;
}

test('ESO-369 (T-04.2): save -> read matches exact hash, version +1 on each save', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    try {
        const project = 'tenant-test';
        const firstSave = await saveConfig(db, {
            project,
            config: { settingA: 'value1', theme: 'dark' },
            operator: 'alice',
        });
        assert.equal(firstSave.version, 1);
        assert.ok(firstSave.hash);
        assert.equal(firstSave.config.settingA, 'value1');

        const readBack1 = await readConfig(db, project);
        assert.ok(readBack1);
        assert.equal(readBack1.version, 1);
        assert.equal(readBack1.hash, firstSave.hash);
        assert.equal(readBack1.config.settingA, 'value1');

        const secondSave = await saveConfig(db, {
            project,
            config: { settingA: 'value2', theme: 'light' },
            expectedHash: firstSave.hash,
            operator: 'bob',
        });
        assert.equal(secondSave.version, 2);
        assert.notEqual(secondSave.hash, firstSave.hash);

        const latest = await readConfig(db, project);
        assert.equal(latest.version, 2);
        assert.equal(latest.hash, secondSave.hash);

        const past = await readConfig(db, project, 1);
        assert.equal(past.version, 1);
        assert.equal(past.hash, firstSave.hash);
        assert.equal(past.config.settingA, 'value1');
    } finally {
        await pg.cleanup();
    }
});

test('ESO-369 (T-04.2): stale hash throws STALE_VERSION error', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    try {
        const project = 'tenant-stale';
        const v1 = await saveConfig(db, { project, config: { key: 'v1' } });
        const v2 = await saveConfig(db, { project, config: { key: 'v2' }, expectedHash: v1.hash });

        await assert.rejects(
            () => saveConfig(db, { project, config: { key: 'v3_conflict' }, expectedHash: v1.hash }),
            (err) => {
                assert.equal(err.code, 'STALE_VERSION');
                assert.equal(err.current_hash, v2.hash);
                assert.equal(err.current_version, 2);
                return true;
            }
        );
    } finally {
        await pg.cleanup();
    }
});

test('ESO-369 (T-04.2): config_event is append-only, UPDATE and DELETE are rejected', async () => {
    const pg = await createTestDb();
    const db = pg.db;
    try {
        const project = 'tenant-events';
        await saveConfig(db, { project, config: { a: 1 } });
        await saveConfig(db, { project, config: { a: 2 } });

        const events = await listConfigEvents(db, project);
        assert.equal(events.length, 2);
        assert.equal(events[0].version, 1);
        assert.equal(events[1].version, 2);

        await assert.rejects(
            () => db.run("UPDATE config_event SET event_type = 'TAMPERED' WHERE version = 1"),
            /append-only/i
        );
        await assert.rejects(
            () => db.run('DELETE FROM config_event WHERE version = 1'),
            /append-only/i
        );
    } finally {
        await pg.cleanup();
    }
});
