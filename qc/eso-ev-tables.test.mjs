import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import {
    initEvidenceSchema,
    EVIDENCE_TABLES,
    recordTurn,
    readTurn,
} from '../eso/evidence/src/index.mjs';

function createDb() {
    const rawDb = new Database(':memory:');
    const db = {
        exec: (sql) => rawDb.exec(sql),
        all: (sql, params = []) => rawDb.query(sql).all(...params),
        run: (sql, params = []) => rawDb.query(sql).run(...params),
        get: (sql, params = []) => rawDb.query(sql).get(...params),
    };
    initEvidenceSchema(db);
    return db;
}

test('SCN-EV-01 (AC-EV-01-01): Runtime records turn with level, mode, basis, Resolved[], and FileUse', () => {
    const db = createDb();
    const project = 'proj-scn-01';

    const turnPayload = {
        project,
        turn_id: 'turn-uuid-01',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
        actor_role: 'developer',
        actor_status: 'FULL',
        rule_version: '2.1.0',
        resolved: [
            { id: 'rel-1', rule: 'RULE-AST-01', provider: 'native', elected: true },
            { id: 'rel-2', rule: 'RULE-AST-02', provider: 'fallback', elected: false },
        ],
        files_used: [
            { path: 'src/main.ts', hash: 'sha256:111111', commit: 'git-commit-abc', dirty: false },
        ],
        payload: {
            guarantee: 'provenance-verified',
            skill_versions: { 'skill-audit': '1.0' },
        },
    };

    const res = recordTurn(db, turnPayload, { isRuntime: true });
    assert.equal(res.ok, true);

    const record = readTurn(db, { project, turn_id: 'turn-uuid-01' });
    assert.equal(record.project, project);
    assert.equal(record.turn_id, 'turn-uuid-01');
    assert.equal(record.level, 'sufficient');
    assert.equal(record.mode, 'do');
    assert.equal(record.basis, 'verified');
    assert.equal(record.actor_status, 'FULL');
    assert.equal(record.resolved.length, 2);
    assert.equal(record.resolved[0].rule, 'RULE-AST-01');
    assert.equal(record.files_used.length, 1);
    assert.equal(record.files_used[0].content_hash, 'sha256:111111');
    assert.equal(record.files_used[0].git_commit, 'git-commit-abc');
    assert.equal(record.files_used[0].dirty, false);
});

test('SCN-EV-02 (AC-EV-01-02 & BR-06): Modifying or deleting recorded evidence aborts with APPEND_ONLY error', () => {
    const db = createDb();
    const project = 'proj-scn-02';

    recordTurn(db, {
        project,
        turn_id: 'turn-locked',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
    }, { isRuntime: true });

    // Attempt UPDATE on evidence_turn
    assert.throws(() => {
        db.run(`UPDATE evidence_turn SET level = 'partial' WHERE turn_id = 'turn-locked'`);
    }, /BR-06/);

    // Attempt DELETE on evidence_turn
    assert.throws(() => {
        db.run(`DELETE FROM evidence_turn WHERE turn_id = 'turn-locked'`);
    }, /BR-06/);

    // Verify row remains untouched
    const row = db.get(`SELECT level FROM evidence_turn WHERE turn_id = 'turn-locked'`);
    assert.equal(row.level, 'sufficient');
});

test('SCN-EV-03 (AC-EV-01-03): Uncommitted file is flagged dirty: true with unreproducible content note', () => {
    const db = createDb();
    const project = 'proj-scn-03';

    recordTurn(db, {
        project,
        turn_id: 'turn-dirty-1',
        level: 'partial',
        mode: 'ask',
        basis: 'inferred',
        files_used: [
            { path: 'src/wip.ts', hash: 'sha256:wip999', dirty: true },
        ],
    }, { isRuntime: true });

    const rec = readTurn(db, { project, turn_id: 'turn-dirty-1' });
    assert.equal(rec.files_used[0].dirty, true);
    assert.ok(rec.files_used[0].note.includes('nội dung không lấy lại được'));
});

test('SCN-EV-04 (AC-EV-01-04 & INV-EV-02): Tenant isolation prevents cross-project evidence visibility (0 rows)', () => {
    const db = createDb();

    // Tenant Alpha records turn
    recordTurn(db, {
        project: 'project-Alpha',
        turn_id: 'turn-alpha-secret',
        level: 'sufficient',
        mode: 'do',
        basis: 'verified',
    }, { isRuntime: true });

    // Tenant Beta queries for turn-alpha-secret
    const queryResult = readTurn(db, {
        project: 'project-Beta',
        turn_id: 'turn-alpha-secret',
    });

    assert.equal(queryResult, null, 'Tenant Beta must NOT see record belonging to Tenant Alpha');
});

test('SCN-EV-05 (AC-EV-01-05 & INV-EV-03): Direct write attempt from non-runtime actor is rejected with DIRECT_WRITE_FORBIDDEN', () => {
    const db = createDb();

    assert.throws(() => {
        recordTurn(db, {
            project: 'proj-direct',
            turn_id: 'turn-direct-1',
        }, { isRuntime: false });
    }, (err) => {
        return err.code === 'DIRECT_WRITE_FORBIDDEN' || err.message.includes('DIRECT_WRITE_FORBIDDEN');
    });
});

test('SCN-EV-15 (AC-EV-01-06 & ED6): Replaying duplicate batch is idempotent and does not create duplicate rows', () => {
    const db = createDb();
    const project = 'proj-idemp-batch';

    const payload = {
        project,
        turn_id: 'turn-batch-1',
        resolved: [
            { rule: 'LAW-1', elected: true },
        ],
    };

    // First delivery
    const res1 = recordTurn(db, payload, { isRuntime: true });
    assert.equal(res1.ok, true);

    // Duplicate delivery
    const res2 = recordTurn(db, payload, { isRuntime: true });
    assert.equal(res2.ok, true);
    assert.equal(res2.idempotentReplay, true);

    // Verify row counts in both tables
    const turns = db.all(`SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ?`, [project, 'turn-batch-1']);
    assert.equal(turns.length, 1);

    const items = db.all(`SELECT * FROM evidence_item WHERE project = ? AND turn_id = ?`, [project, 'turn-batch-1']);
    assert.equal(items.length, 1);
});

test('SCN-EV-16 (AC-EV-01-07 & ED10): Preserves content_hash and commit when FileUse points to a deleted file and sets gone: true', () => {
    const db = createDb();
    const project = 'proj-dangling-file';

    recordTurn(db, {
        project,
        turn_id: 'turn-df-1',
        files_used: [
            { path: 'src/deleted_artifact.ts', hash: 'sha256:permanent-hash', commit: 'commit-orig', dirty: false },
        ],
    }, { isRuntime: true });

    // Mock filesystem where 'src/deleted_artifact.ts' no longer exists
    const mockFs = (path) => false;

    const read = readTurn(db, {
        project,
        turn_id: 'turn-df-1',
        fsExists: mockFs,
    });

    assert.equal(read.files_used.length, 1);
    assert.equal(read.files_used[0].gone, true, 'Deleted file must be flagged gone: true');
    assert.equal(read.files_used[0].content_hash, 'sha256:permanent-hash', 'content_hash must remain preserved');
    assert.equal(read.files_used[0].git_commit, 'commit-orig', 'git_commit must remain preserved');
});
