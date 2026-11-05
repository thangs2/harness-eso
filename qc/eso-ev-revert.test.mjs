import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initEvidenceSchema,
    recordTurn,
    recordConfigSave,
    revertConfig,
    computeMarkedArtefacts,
} from '../eso/evidence/src/index.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/** D-93: isolated PostgreSQL schema per test, cleaned up in `finally`. */
async function withDb(fn) {
    const pg = await createTestPgDb();
    try {
        await initEvidenceSchema(pg.db);
        return await fn(pg.db);
    } finally {
        await pg.cleanup();
    }
}

test('SCN-EV-06 (AC-EV-02-01): Artefact created in [publish, revert) window is marked with event_id and reverted_version', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-06';
        const publishAt = '2026-11-04T10:00:00.000Z';
        const midAt = '2026-11-04T10:30:00.000Z';
        const revertAt = '2026-11-04T11:00:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-v13',
            version: 13,
            at: publishAt,
        });

        await recordTurn(db, {
            project,
            turn_id: 'turn-v13-art',
            at: midAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: {
                artifacts: [{ id: 'artefact-101', path: 'src/module.ts' }],
            },
        }, { isRuntime: true });

        const result = await revertConfig(db, {
            project,
            event_id: 'save-v13',
            revert_event_id: 'revert-evt-06',
            at: revertAt,
        });

        assert.equal(result.reverted_to, 12);
        assert.equal(result.marked_artifacts.length, 1);
        const art = result.marked_artifacts[0];
        assert.equal(art.artefact_id, 'artefact-101');
        assert.equal(art.marked, true);
        assert.equal(art.reverted_version, 13);
        assert.equal(art.event_id, 'revert-evt-06');
        assert.equal(art.artefact_state, 'present');
    });
});

test('SCN-EV-07 (AC-EV-02-02): Artefact created outside window is NOT marked', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-07';
        const publishAt = '2026-11-04T10:00:00.000Z';
        const beforeAt = '2026-11-04T09:59:59.000Z';
        const revertAt = '2026-11-04T11:00:00.000Z';
        const afterAt = '2026-11-04T11:00:00.000Z'; // exactly at upper bound (revertAt)

        await recordConfigSave(db, {
            project,
            event_id: 'save-v2',
            version: 2,
            at: publishAt,
        });

        await recordTurn(db, {
            project,
            turn_id: 'turn-outside-before',
            at: beforeAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-outside-1'] },
        }, { isRuntime: true });

        await recordTurn(db, {
            project,
            turn_id: 'turn-outside-after',
            at: afterAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-outside-2'] },
        }, { isRuntime: true });

        const result = await revertConfig(db, {
            project,
            event_id: 'save-v2',
            revert_event_id: 'revert-evt-07',
            at: revertAt,
        });

        assert.equal(result.marked_artifacts.length, 0, 'No artefacts outside window should be marked');
        assert.deepEqual(result.marked_artifacts, []);
    });
});

test('SCN-EV-08 (AC-EV-02-03): MUTATE_FORBIDDEN: Artefact bytes remain unchanged and config_event is append-only', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-08';
        const publishAt = '2026-11-04T10:00:00.000Z';
        const midAt = '2026-11-04T10:15:00.000Z';
        const revertAt = '2026-11-04T10:45:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-v4',
            version: 4,
            at: publishAt,
        });

        await recordTurn(db, {
            project,
            turn_id: 'turn-immutable',
            at: midAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: {
                artifacts: [{ id: 'art-fixed', sha256: 'immutable_hash_value' }],
            },
        }, { isRuntime: true });

        const turnBefore = await db.get('SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ?', [project, 'turn-immutable']);

        await revertConfig(db, {
            project,
            event_id: 'save-v4',
            revert_event_id: 'revert-evt-08',
            at: revertAt,
        });

        const turnAfter = await db.get('SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ?', [project, 'turn-immutable']);
        assert.deepEqual(turnBefore, turnAfter, 'Artefact and turn records must never be mutated (MUTATE_FORBIDDEN)');

        // BR-06: triggers block UPDATE and DELETE on config_event
        await assert.rejects(() => db.run('UPDATE config_event SET version = 999 WHERE project = ?', [project]), /BR-06/);

        await assert.rejects(() => db.run('DELETE FROM config_event WHERE project = ?', [project]), /BR-06/);
    });
});

test('SCN-EV-17 (AC-EV-02-04): Empty window returns marked_artifacts: [] with window timestamps, 0 error', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-17';
        const publishAt = '2026-11-04T10:00:00.000Z';
        const revertAt = '2026-11-04T11:00:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-empty-win',
            version: 6,
            at: publishAt,
        });

        const result = await revertConfig(db, {
            project,
            event_id: 'save-empty-win',
            revert_event_id: 'revert-evt-17',
            at: revertAt,
        });

        assert.equal(result.reverted_to, 5);
        assert.deepEqual(result.marked_artifacts, []);
        assert.equal(result.window.from, publishAt);
        assert.equal(result.window.to, revertAt);
    });
});

test('SCN-EV-18 (AC-EV-02-05): Deleted artefact within window is flagged artefact_state: deleted with 0 crash', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-18';
        const publishAt = '2026-11-04T10:00:00.000Z';
        const midAt = '2026-11-04T10:30:00.000Z';
        const revertAt = '2026-11-04T11:00:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-dangling-win',
            version: 3,
            at: publishAt,
        });

        await recordTurn(db, {
            project,
            turn_id: 'turn-dangling-art',
            at: midAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: {
                artifacts: [{ id: 'art-deleted-1', deleted: true, artefact_state: 'deleted' }],
            },
        }, { isRuntime: true });

        const result = await revertConfig(db, {
            project,
            event_id: 'save-dangling-win',
            revert_event_id: 'revert-evt-18',
            at: revertAt,
        });

        assert.equal(result.marked_artifacts.length, 1);
        const art = result.marked_artifacts[0];
        assert.equal(art.artefact_id, 'art-deleted-1');
        assert.equal(art.marked, true);
        assert.equal(art.artefact_state, 'deleted');
        assert.equal(art.DANGLING_ARTEFACT, true);
        assert.equal(art.dangling, true);
    });
});

test('SCN-EV-19: Boundary half-open tests: [publish.at] is INCLUDED, [revert.at] is EXCLUDED', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-19';
        const publishAt = '2026-11-04T12:00:00.000Z';
        const revertAt = '2026-11-04T13:00:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-bounds',
            version: 10,
            at: publishAt,
        });

        // Lower bound turn: exactly at publishAt
        await recordTurn(db, {
            project,
            turn_id: 'turn-lower',
            at: publishAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-lower'] },
        }, { isRuntime: true });

        // Upper bound turn: exactly at revertAt
        await recordTurn(db, {
            project,
            turn_id: 'turn-upper',
            at: revertAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-upper'] },
        }, { isRuntime: true });

        const result = await revertConfig(db, {
            project,
            event_id: 'save-bounds',
            revert_event_id: 'revert-evt-19',
            at: revertAt,
        });

        assert.equal(result.marked_artifacts.length, 1);
        assert.equal(result.marked_artifacts[0].artefact_id, 'art-lower');
    });
});

test('SCN-EV-20: Idempotency & late outbox recomputation', async () => {
    await withDb(async (db) => {
        const project = 'proj-ev-20';
        const publishAt = '2026-11-04T14:00:00.000Z';
        const midAt1 = '2026-11-04T14:15:00.000Z';
        const midAt2 = '2026-11-04T14:45:00.000Z';
        const revertAt = '2026-11-04T15:00:00.000Z';

        await recordConfigSave(db, {
            project,
            event_id: 'save-idemp',
            version: 15,
            at: publishAt,
        });

        await recordTurn(db, {
            project,
            turn_id: 'turn-idemp-1',
            at: midAt1,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-early'] },
        }, { isRuntime: true });

        const r1 = await revertConfig(db, {
            project,
            event_id: 'save-idemp',
            revert_event_id: 'revert-evt-20',
            at: revertAt,
        });

        const r2 = await revertConfig(db, {
            project,
            event_id: 'save-idemp',
            revert_event_id: 'revert-evt-20',
            at: revertAt,
        });

        assert.deepEqual(r1.marked_artifacts, r2.marked_artifacts);

        // Turn arriving later via outbox
        await recordTurn(db, {
            project,
            turn_id: 'turn-idemp-2',
            at: midAt2,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-late'] },
        }, { isRuntime: true });

        const recomputed = await computeMarkedArtefacts(db, {
            project,
            revert_event_id: 'revert-evt-20',
        });

        assert.equal(recomputed.length, 2);
        assert(recomputed.some((a) => a.artefact_id === 'art-early'));
        assert(recomputed.some((a) => a.artefact_id === 'art-late'));
    });
});

test('SCN-EV-21: Project isolation: Project A revert does not mark or leak Project B artefacts', async () => {
    await withDb(async (db) => {
        const publishAt = '2026-11-04T10:00:00.000Z';
        const midAt = '2026-11-04T10:30:00.000Z';
        const revertAt = '2026-11-04T11:00:00.000Z';

        await recordConfigSave(db, {
            project: 'proj-A',
            event_id: 'save-A',
            version: 2,
            at: publishAt,
        });

        await recordConfigSave(db, {
            project: 'proj-B',
            event_id: 'save-B',
            version: 2,
            at: publishAt,
        });

        await recordTurn(db, {
            project: 'proj-A',
            turn_id: 'turn-A',
            at: midAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-A'] },
        }, { isRuntime: true });

        await recordTurn(db, {
            project: 'proj-B',
            turn_id: 'turn-B',
            at: midAt,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            payload: { artifacts: ['art-B'] },
        }, { isRuntime: true });

        const resultA = await revertConfig(db, {
            project: 'proj-A',
            event_id: 'save-A',
            revert_event_id: 'revert-A',
            at: revertAt,
        });

        assert.equal(resultA.marked_artifacts.length, 1);
        assert.equal(resultA.marked_artifacts[0].artefact_id, 'art-A');
        assert.equal(resultA.marked_artifacts.some((a) => a.artefact_id === 'art-B'), false);
    });
});
