import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initEvidenceSchema,
    recordTurn,
    replayTurn,
    diffReplays,
} from '../eso/evidence/src/index.mjs';
import { createTestPgDb } from './helpers/test-pg-db.mjs';

/** D-93: isolated PostgreSQL schema per test; no SQLite memory store. */
async function withDb(fn) {
    const pg = await createTestPgDb();
    try {
        await initEvidenceSchema(pg.db);
        return await fn(pg.db);
    } finally {
        await pg.cleanup();
    }
}

test('SCN-EV-09 (AC-EV-03-01): Replayed turn matches recorded level, mode, basis, Resolved[], and FileUse[]', async () => {
    await withDb(async (db) => {
        const project = 'proj-replay-09';
        const turn_id = 't-uuid-09';

        await recordTurn(db, {
            project,
            turn_id,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            actor_role: 'developer',
            actor_status: 'FULL',
            resolved: [
                { rule: 'LAW-101', provider: 'native', elected: true },
                { rule: 'LAW-102', provider: 'fallback', elected: false },
            ],
            files_used: [
                { path: 'src/core/engine.ts', hash: 'sha256:engine123', commit: 'commit_hash_1', dirty: false },
            ],
            payload: {
                guarantee: 'evidence-backed',
                skill_versions: { 'skill-replay': '2.0.0' },
            },
        }, { isRuntime: true });

        const rep = await replayTurn(db, { project, turn_id });
        assert.equal(rep.project, project);
        assert.equal(rep.turn_id, turn_id);
        assert.equal(rep.level, 'sufficient');
        assert.equal(rep.mode, 'do');
        assert.equal(rep.basis, 'verified');
        assert.equal(rep.resolved.length, 2);
        assert.equal(rep.resolved[0].rule, 'LAW-101');
        assert.equal(rep.files_used.length, 1);
        assert.equal(rep.files_used[0].content_hash, 'sha256:engine123');
        assert.equal(rep.files_used[0].git_commit, 'commit_hash_1');
        assert.equal(rep.skill_versions['skill-replay'], '2.0.0');
    });
});

test('SCN-EV-10 (AC-EV-03-02): Uncommitted file has dirty: true and explicit note "nội dung không lấy lại được"', async () => {
    await withDb(async (db) => {
        const project = 'proj-replay-10';
        const turn_id = 't-dirty-10';

        await recordTurn(db, {
            project,
            turn_id,
            level: 'partial',
            mode: 'ask',
            basis: 'inferred',
            files_used: [
                { path: 'src/temp.ts', hash: 'sha256:dirty_hash', dirty: true },
            ],
        }, { isRuntime: true });

        const rep = await replayTurn(db, { project, turn_id });
        assert.equal(rep.files_used[0].dirty, true);
        assert.ok(rep.files_used[0].note.includes('nội dung không lấy lại được'));
    });
});

test('SCN-EV-11 (AC-EV-03-03): Cross-project query returns 0 rows (null) without metadata leakage', async () => {
    await withDb(async (db) => {
        const turn_id = 't-alpha-private';

        await recordTurn(db, {
            project: 'project-Alpha',
            turn_id,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
        }, { isRuntime: true });

        // Project-Beta attempts to replay Alpha's turn
        const rep = await replayTurn(db, { project: 'project-Beta', turn_id });
        assert.equal(rep, null, 'Must return null (0 rows) for out-of-scope query');
    });
});

test('SCN-EV-23 (Gate W2): Replaying a turn twice produces zero diff', async () => {
    await withDb(async (db) => {
        const project = 'proj-gate-w2';
        const turn_id = 'turn-w2-id';

        await recordTurn(db, {
            project,
            turn_id,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            resolved: [{ rule: 'RULE-W2', elected: true }],
            files_used: [{ path: 'src/w2.ts', hash: 'sha:w2', commit: 'comm_w2', dirty: false }],
            payload: { skill_versions: { 'skill-w2': '1.0' } },
        }, { isRuntime: true });

        const run1 = await replayTurn(db, { project, turn_id });
        const run2 = await replayTurn(db, { project, turn_id });

        const diff = diffReplays(run1, run2);
        assert.deepEqual(diff, [], 'Two sequential replays must yield empty diff (Gate W2)');
    });
});

test('SCN-EV-24 (AC-EV-03-04 & ED1): Turn that read 0 files returns files_used: [] empty array, never null', async () => {
    await withDb(async (db) => {
        const project = 'proj-replay-24';
        const turn_id = 't-nofiles-24';

        await recordTurn(db, {
            project,
            turn_id,
            level: 'cannot-judge',
            mode: 'ask',
            basis: 'inferred',
            files_used: [],
        }, { isRuntime: true });

        const rep = await replayTurn(db, { project, turn_id });
        assert.ok(Array.isArray(rep.files_used));
        assert.equal(rep.files_used.length, 0);
        assert.notEqual(rep.files_used, null);
    });
});

test('SCN-EV-25 (AC-EV-03-05 & ED10): Turn referencing deleted file flags dangling: true and gone: true without crashing', async () => {
    await withDb(async (db) => {
        const project = 'proj-replay-25';
        const turn_id = 't-dangling-25';

        await recordTurn(db, {
            project,
            turn_id,
            level: 'sufficient',
            mode: 'do',
            basis: 'verified',
            files_used: [
                { path: 'src/deleted_schema.sql', hash: 'sha:permanent_schema', commit: 'commit_ancient', dirty: false },
            ],
        }, { isRuntime: true });

        // Mock filesystem where file does not exist
        const mockFs = (p) => false;

        const rep = await replayTurn(db, {
            project,
            turn_id,
            fsExists: mockFs,
        });

        assert.equal(rep.files_used.length, 1);
        assert.equal(rep.files_used[0].dangling, true);
        assert.equal(rep.files_used[0].gone, true);
        assert.equal(rep.files_used[0].content_hash, 'sha:permanent_schema');
        assert.equal(rep.files_used[0].git_commit, 'commit_ancient');
    });
});
