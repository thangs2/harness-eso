/**
 * Unit tests for @mu/eso-evidence (Ticket ESO-65 / Slice S1)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from '../../../qc/helpers/test-pg-db.mjs';

import {
    initEvidenceSchema,
    EVIDENCE_TABLES,
    recordTurn,
    readTurn,
    OutboxBuffer,
    flushOutbox,
    IngestWorker,
    openRisk,
    closeRisk,
    getRiskHistory,
    listActiveRisks,
    replayTurn,
    diffReplays,
    recordConfigSave,
    revertConfig,
    computeMarkedArtefacts,
} from '../src/index.mjs';

async function createTestDb() {
    const pg = await createTestPgDb();
    await initEvidenceSchema(pg.db);
    return pg;
}

describe('@mu/eso-evidence — Unit Test Suite (Slice S1)', () => {
    let db;
    let pg;

    beforeEach(async () => {
        pg = await createTestDb();
        db = pg.db;
    });

    afterEach(async () => {
        if (pg) await pg.cleanup();
        pg = null;
        db = null;
    });

    describe('Schema DDL & Idempotency', () => {
        it('creates 3 evidence tables and is idempotent when re-run', async () => {
            await assert.doesNotReject(() => initEvidenceSchema(db));
            const rows = await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()");
            const tableNames = rows.map((r) => r.name);

            for (const tbl of EVIDENCE_TABLES) {
                assert.ok(tableNames.includes(tbl), `Table ${tbl} must exist`);
            }
        });
    });

    describe('BR-06: Append-only enforcement on all evidence tables', () => {
        it('allows INSERT but aborts UPDATE on evidence_turn', async () => {
            await db.run(`INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version)
                    VALUES ('p1', 't1', '2026-11-03', 'agent', 'FULL', 'sufficient', 'do', 'verified', '1.0')`);

            await assert.rejects(async () => {
                await db.run(`UPDATE evidence_turn SET level = 'partial' WHERE turn_id = 't1'`);
            }, /BR-06/);
        });

        it('aborts DELETE on evidence_turn', async () => {
            await db.run(`INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version)
                    VALUES ('p1', 't1', '2026-11-03', 'agent', 'FULL', 'sufficient', 'do', 'verified', '1.0')`);

            await assert.rejects(async () => {
                await db.run(`DELETE FROM evidence_turn WHERE turn_id = 't1'`);
            }, /BR-06/);
        });

        it('allows INSERT but aborts UPDATE and DELETE on evidence_item', async () => {
            await db.run(`INSERT INTO evidence_turn (project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version)
                    VALUES ('p1', 't1', '2026-11-03', 'agent', 'FULL', 'sufficient', 'do', 'verified', '1.0')`);
            await db.run(`INSERT INTO evidence_item (project, turn_id, seq, kind, payload)
                    VALUES ('p1', 't1', 1, 'claim', '{"test":true}')`);

            await assert.rejects(async () => {
                await db.run(`UPDATE evidence_item SET kind = 'election' WHERE turn_id = 't1'`);
            }, /BR-06/);

            await assert.rejects(async () => {
                await db.run(`DELETE FROM evidence_item WHERE turn_id = 't1'`);
            }, /BR-06/);
        });

        it('allows INSERT but aborts UPDATE and DELETE on evidence_risk', async () => {
            await db.run(`INSERT INTO evidence_risk (project, risk_id, seq, at, event, actor, payload)
                    VALUES ('p1', 'r1', 1, '2026-11-03', 'open', 'operator', '{"desc":"debt"}')`);

            await assert.rejects(async () => {
                await db.run(`UPDATE evidence_risk SET event = 'close' WHERE risk_id = 'r1'`);
            }, /BR-06/);

            await assert.rejects(async () => {
                await db.run(`DELETE FROM evidence_risk WHERE risk_id = 'r1'`);
            }, /BR-06/);
        });
    });

    describe('AC-EV-01 Acceptance Criteria & Invariants', () => {
        it('AC-EV-01-01: records turn with level, mode, basis, Resolved[], and FileUse', async () => {
            const turnPayload = {
                project: 'proj-ac1',
                turn_id: 'turn-101',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                resolved: [
                    { rule: 'LAW-01', provider: 'native-ast', elected: true },
                    { rule: 'LAW-02', provider: 'fallback', elected: false },
                ],
                files_used: [
                    { path: 'src/core.ts', hash: 'sha256:abc', commit: 'c0ffee', dirty: false },
                ],
            };

            const recResult = await recordTurn(db, turnPayload, { isRuntime: true });
            assert.equal(recResult.ok, true);

            const readBack = await readTurn(db, { project: 'proj-ac1', turn_id: 'turn-101' });
            assert.equal(readBack.project, 'proj-ac1');
            assert.equal(readBack.turn_id, 'turn-101');
            assert.equal(readBack.level, 'sufficient');
            assert.equal(readBack.mode, 'do');
            assert.equal(readBack.basis, 'verified');
            assert.equal(readBack.resolved.length, 2);
            assert.equal(readBack.resolved[0].rule, 'LAW-01');
            assert.equal(readBack.files_used.length, 1);
            assert.equal(readBack.files_used[0].content_hash, 'sha256:abc');
            assert.equal(readBack.files_used[0].dirty, false);
        });

        it('AC-EV-01-03: uncommitted file is flagged dirty: true with unreproducible note', async () => {
            const turnPayload = {
                project: 'proj-ac3',
                turn_id: 'turn-103',
                level: 'sufficient',
                mode: 'do',
                basis: 'retrieved',
                files_used: [
                    { path: 'src/scratch.ts', hash: 'sha256:dirty123', dirty: true },
                ],
            };

            await recordTurn(db, turnPayload, { isRuntime: true });

            const readBack = await readTurn(db, { project: 'proj-ac3', turn_id: 'turn-103' });
            assert.equal(readBack.files_used[0].dirty, true);
            assert.ok(readBack.files_used[0].note.includes('nội dung không lấy lại được'));
        });

        it('AC-EV-01-04: enforces tenant isolation, returning null for cross-project queries', async () => {
            await recordTurn(db, {
                project: 'project-A',
                turn_id: 'turn-common',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
            }, { isRuntime: true });

            // Project B queries turn-common
            const readCross = await readTurn(db, { project: 'project-B', turn_id: 'turn-common' });
            assert.equal(readCross, null, 'Must NOT return record belonging to project-A');
        });

        it('AC-EV-01-05: rejects direct write attempt from non-runtime caller with DIRECT_WRITE_FORBIDDEN', async () => {
            await assert.rejects(async () => {
                await recordTurn(db, {
                    project: 'p1',
                    turn_id: 't-unauth',
                }, { isRuntime: false });
            }, /DIRECT_WRITE_FORBIDDEN/);
        });

        it('AC-EV-01-06 / ED6: idempotent submission: duplicate batch does not create duplicate rows', async () => {
            const payload = {
                project: 'proj-idemp',
                turn_id: 'turn-idemp-1',
                resolved: [{ elected: true }],
            };

            const first = await recordTurn(db, payload, { isRuntime: true });
            assert.equal(first.ok, true);

            // Re-submit identical batch
            const second = await recordTurn(db, payload, { isRuntime: true });
            assert.equal(second.ok, true);
            assert.equal(second.idempotentReplay, true);

            const items = await db.all(`SELECT * FROM evidence_item WHERE project = 'proj-idemp' AND turn_id = 'turn-idemp-1'`);
            assert.equal(items.length, 1, 'Items must not be duplicated');
        });

        it('AC-EV-01-07 / ED10: flags gone: true when FileUse references a deleted file while keeping hash and commit', async () => {
            await recordTurn(db, {
                project: 'proj-gone',
                turn_id: 'turn-gone-1',
                files_used: [
                    { path: 'src/deleted_file.ts', hash: 'sha256:orig', commit: 'gitcommit1', dirty: false },
                    { path: 'src/existing_file.ts', hash: 'sha256:alive', commit: 'gitcommit2', dirty: false },
                ],
            }, { isRuntime: true });

            // Mock filesystem check
            const mockFsExists = (path) => path === 'src/existing_file.ts';

            const res = await readTurn(db, {
                project: 'proj-gone',
                turn_id: 'turn-gone-1',
                fsExists: mockFsExists,
            });

            assert.equal(res.files_used.length, 2);
            assert.equal(res.files_used[0].path, 'src/deleted_file.ts');
            assert.equal(res.files_used[0].gone, true, 'Deleted file must have gone: true');
            assert.equal(res.files_used[0].content_hash, 'sha256:orig', 'Hash must be preserved');
            assert.equal(res.files_used[0].git_commit, 'gitcommit1', 'Commit must be preserved');

            assert.equal(res.files_used[1].path, 'src/existing_file.ts');
            assert.equal(res.files_used[1].gone, false);
        });
    });

    describe('Ticket ESO-70: Outbox Ingest Pipeline (US-EV-01 / Slice S1)', () => {
        it('D-20: outbox enqueues synchronously without blocking on database', async () => {
            const outbox = new OutboxBuffer();
            const res = outbox.write({
                project: 'p-outbox-1',
                turn_id: 't-outbox-1',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
            });

            assert.equal(res.queued, true);
            assert.equal(outbox.size(), 1);
        });

        it('flushOutbox ships entries into target database idempotently and acks them', async () => {
            const outbox = new OutboxBuffer();
            outbox.write({
                project: 'p-outbox-2',
                turn_id: 't-outbox-2',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                resolved: [{ rule: 'LAW-1', elected: true }],
            });

            const flushResult = await flushOutbox(outbox, db);
            assert.equal(flushResult.shippedCount, 1);
            assert.equal(flushResult.failedCount, 0);
            assert.equal(outbox.size(), 0);

            // Verify in db
            const read = await readTurn(db, { project: 'p-outbox-2', turn_id: 't-outbox-2' });
            assert.equal(read.turn_id, 't-outbox-2');
            assert.equal(read.resolved.length, 1);
        });

        it('retains entries in outbox for retry if database operation fails', async () => {
            const outbox = new OutboxBuffer();
            outbox.write({
                project: 'p-failing',
                turn_id: 't-fail-1',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
            });

            // Mock database that throws connection/transient error
            const failingDb = {
                get: () => { throw new Error('DB Connection Refused (Simulated 503)'); },
                run: () => { throw new Error('DB Connection Refused (Simulated 503)'); },
                all: () => [],
            };

            const flushResult = await flushOutbox(outbox, failingDb);
            assert.equal(flushResult.shippedCount, 0);
            assert.equal(flushResult.failedCount, 1);
            assert.equal(outbox.size(), 1, 'Item must NOT be removed from outbox on DB failure');

            // Now flush with real working db -> succeeds
            const retryResult = await flushOutbox(outbox, db);
            assert.equal(retryResult.shippedCount, 1);
            assert.equal(outbox.size(), 0);
        });
    });

    describe('Ticket ESO-75: Risk Lifecycle (US-EV-04 / Slice S1)', () => {
        it('AC-EV-04-01: closing a risk appends closed event with actor and reason, preserving opened history', async () => {
            await openRisk(db, {
                project: 'proj-r1',
                risk_id: 'risk-101',
                actor: 'scanner',
                payload: { debt: 'AST missing' },
            });

            const closeRes = await closeRisk(db, {
                project: 'proj-r1',
                risk_id: 'risk-101',
                actor: 'lead-dev',
                reason: 'Refactored AST extractor to cover missing symbols',
            });

            assert.equal(closeRes.ok, true);
            assert.equal(closeRes.seq, 2);
            assert.equal(closeRes.event, 'closed');
            assert.equal(closeRes.by, 'lead-dev');

            const history = await getRiskHistory(db, { project: 'proj-r1', risk_id: 'risk-101' });
            assert.equal(history.length, 2);
            assert.equal(history[0].event, 'opened');
            assert.equal(history[1].event, 'closed');
            assert.equal(history[1].payload.reason, 'Refactored AST extractor to cover missing symbols');
        });

        it('AC-EV-04-03: closed risks are excluded from listActiveRisks (proposals)', async () => {
            await openRisk(db, { project: 'proj-r3', risk_id: 'risk-open', actor: 'scanner' });
            await openRisk(db, { project: 'proj-r3', risk_id: 'risk-to-close', actor: 'scanner' });

            await closeRisk(db, {
                project: 'proj-r3',
                risk_id: 'risk-to-close',
                actor: 'operator',
                reason: 'Mitigated in production',
            });

            const active = await listActiveRisks(db, { project: 'proj-r3' });
            assert.equal(active.length, 1);
            assert.equal(active[0].risk_id, 'risk-open');
        });

        it('AC-EV-04-04 / ED6: closing an already closed risk throws ALREADY_CLOSED and does not append event', async () => {
            await openRisk(db, { project: 'proj-r4', risk_id: 'risk-twice', actor: 'scanner' });
            await closeRisk(db, { project: 'proj-r4', risk_id: 'risk-twice', actor: 'lead', reason: 'Fixed' });

            await assert.rejects(async () => {
                await closeRisk(db, { project: 'proj-r4', risk_id: 'risk-twice', actor: 'lead', reason: 'Fixed again' });
            }, (err) => {
                return err.code === 'ALREADY_CLOSED' || err.message.includes('ALREADY_CLOSED');
            });

            const history = await getRiskHistory(db, { project: 'proj-r4', risk_id: 'risk-twice' });
            assert.equal(history.length, 2, 'Must have exactly 2 events (opened and 1 closed)');
        });

        it('AC-EV-04-05 / ED7: deterministic event order: closed risk does not enter proposal clusters', async () => {
            await openRisk(db, { project: 'proj-race', risk_id: 'risk-race', actor: 'agent' });
            await closeRisk(db, { project: 'proj-race', risk_id: 'risk-race', actor: 'reviewer', reason: 'Closed before cluster' });

            const cluster = await listActiveRisks(db, { project: 'proj-race' });
            const inCluster = cluster.some((r) => r.risk_id === 'risk-race');
            assert.equal(inCluster, false, 'Closed risk must never enter active proposal cluster');
        });
    });

    describe('Ticket ESO-80: Replay Turn (US-EV-03 / Slice S1)', () => {
        it('AC-EV-03-01: replays matching level, mode, basis, Resolved[], and FileUse[]', async () => {
            await recordTurn(db, {
                project: 'proj-rep-1',
                turn_id: 'turn-rep-101',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                resolved: [{ rule: 'LAW-1', provider: 'native', elected: true }],
                files_used: [{ path: 'src/core.ts', hash: 'sha:core', commit: 'c1' }],
                payload: { skill_versions: { 'skill-audit': '1.0' } },
            }, { isRuntime: true });

            const rep = await replayTurn(db, { project: 'proj-rep-1', turn_id: 'turn-rep-101' });
            assert.equal(rep.level, 'sufficient');
            assert.equal(rep.mode, 'do');
            assert.equal(rep.basis, 'verified');
            assert.equal(rep.resolved.length, 1);
            assert.equal(rep.files_used.length, 1);
            assert.equal(rep.skill_versions['skill-audit'], '1.0');
        });

        it('AC-EV-03-02: explicit note for dirty file', async () => {
            await recordTurn(db, {
                project: 'proj-rep-2',
                turn_id: 'turn-rep-102',
                level: 'partial',
                mode: 'ask',
                basis: 'retrieved',
                files_used: [{ path: 'src/wip.ts', hash: 'sha:wip', dirty: true }],
            }, { isRuntime: true });

            const rep = await replayTurn(db, { project: 'proj-rep-2', turn_id: 'turn-rep-102' });
            assert.equal(rep.files_used[0].dirty, true);
            assert.ok(rep.files_used[0].note.includes('nội dung không lấy lại được'));
        });

        it('AC-EV-03-03: cross-project query returns null', async () => {
            await recordTurn(db, {
                project: 'proj-rep-3A',
                turn_id: 'turn-rep-secret',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
            }, { isRuntime: true });

            const rep = await replayTurn(db, { project: 'proj-rep-3B', turn_id: 'turn-rep-secret' });
            assert.equal(rep, null);
        });

        it('AC-EV-03-04 / ED1: turn that read 0 files returns files_used: [] empty array, never null', async () => {
            await recordTurn(db, {
                project: 'proj-rep-4',
                turn_id: 'turn-rep-nofiles',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                files_used: [],
            }, { isRuntime: true });

            const rep = await replayTurn(db, { project: 'proj-rep-4', turn_id: 'turn-rep-nofiles' });
            assert.ok(Array.isArray(rep.files_used), 'files_used must be an array');
            assert.equal(rep.files_used.length, 0);
            assert.notEqual(rep.files_used, null);
        });

        it('AC-EV-03-05 / ED10: deleted file marked dangling: true and gone: true, 0 crash', async () => {
            await recordTurn(db, {
                project: 'proj-rep-5',
                turn_id: 'turn-rep-dangling',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                files_used: [{ path: 'src/removed.ts', hash: 'sha:rem', commit: 'c_old' }],
            }, { isRuntime: true });

            const mockFs = () => false; // file removed
            const rep = await replayTurn(db, {
                project: 'proj-rep-5',
                turn_id: 'turn-rep-dangling',
                fsExists: mockFs,
            });

            assert.equal(rep.files_used[0].dangling, true);
            assert.equal(rep.files_used[0].gone, true);
            assert.equal(rep.files_used[0].content_hash, 'sha:rem');
        });

        it('Gate W2: replaying twice produces completely identical output (zero diff)', async () => {
            await recordTurn(db, {
                project: 'proj-w2',
                turn_id: 'turn-w2-det',
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                resolved: [{ rule: 'RULE-1' }, { rule: 'RULE-2' }],
                files_used: [{ path: 'src/file.ts', hash: 'sha:1' }],
                payload: { skill_versions: { 'skill-a': '1.2' } },
            }, { isRuntime: true });

            const pass1 = await replayTurn(db, { project: 'proj-w2', turn_id: 'turn-w2-det' });
            const pass2 = await replayTurn(db, { project: 'proj-w2', turn_id: 'turn-w2-det' });

            const diff = diffReplays(pass1, pass2);
            assert.deepEqual(diff, [], 'Replaying twice must produce zero diff (Gate W2)');
        });
    });

    describe('US-EV-02: Revert Marking & Window Isolation (ESO-85 / Slice S1)', () => {
        it('AC-EV-02-01: Artefact created in [publish, revert) window is marked with reverted_version and event_id', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const midAt = '2026-11-04T01:30:00.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-rev-1',
                event_id: 'save-evt-1',
                version: 13,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-rev-1',
                turn_id: 'turn-rev-1',
                at: midAt,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: {
                    artifacts: [{ id: 'art-window-1', path: 'src/a.ts' }],
                },
            }, { isRuntime: true });

            const res = await revertConfig(db, {
                project: 'proj-rev-1',
                event_id: 'save-evt-1',
                revert_event_id: 'rev-evt-1',
                at: revAt,
            });

            assert.equal(res.reverted_to, 12);
            assert.equal(res.marked_artifacts.length, 1);
            assert.equal(res.marked_artifacts[0].artefact_id, 'art-window-1');
            assert.equal(res.marked_artifacts[0].marked, true);
            assert.equal(res.marked_artifacts[0].reverted_version, 13);
            assert.equal(res.marked_artifacts[0].event_id, 'rev-evt-1');
            assert.equal(res.marked_artifacts[0].artefact_state, 'present');
        });

        it('AC-EV-02-02: Artefacts created outside [publish, revert) window are NOT marked', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const beforeAt = '2026-11-04T00:59:59.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';
            const afterAt = '2026-11-04T02:00:00.000Z'; // exactly at upper boundary (half-open)

            await recordConfigSave(db, {
                project: 'proj-rev-2',
                event_id: 'save-evt-2',
                version: 2,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-rev-2',
                turn_id: 'turn-before',
                at: beforeAt,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: ['art-before'] },
            }, { isRuntime: true });

            await recordTurn(db, {
                project: 'proj-rev-2',
                turn_id: 'turn-at-upper',
                at: afterAt,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: ['art-upper'] },
            }, { isRuntime: true });

            const res = await revertConfig(db, {
                project: 'proj-rev-2',
                event_id: 'save-evt-2',
                revert_event_id: 'rev-evt-2',
                at: revAt,
            });

            assert.equal(res.marked_artifacts.length, 0, 'No artefacts outside window should be marked');
            assert.deepEqual(res.marked_artifacts, []);
        });

        it('AC-EV-02-03: MUTATE_FORBIDDEN: Artefact bytes/records are never mutated, config_event is append-only', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const midAt = '2026-11-04T01:10:00.000Z';
            const revAt = '2026-11-04T01:20:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-rev-3',
                event_id: 'save-evt-3',
                version: 5,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-rev-3',
                turn_id: 'turn-immutable',
                at: midAt,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: [{ id: 'art-imm', content_hash: 'sha:fixed' }] },
            }, { isRuntime: true });

            const turnBefore = await db.get('SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ?', ['proj-rev-3', 'turn-immutable']);

            await revertConfig(db, {
                project: 'proj-rev-3',
                event_id: 'save-evt-3',
                at: revAt,
            });

            const turnAfter = await db.get('SELECT * FROM evidence_turn WHERE project = ? AND turn_id = ?', ['proj-rev-3', 'turn-immutable']);
            assert.deepEqual(turnBefore, turnAfter, 'evidence_turn row must be strictly identical before and after revert');

            // BR-06: config_event append-only trigger prevents UPDATE and DELETE
            await assert.rejects(async () => {
                await db.run('UPDATE config_event SET version = 99 WHERE project = ?', ['proj-rev-3']);
            }, /BR-06/);

            await assert.rejects(async () => {
                await db.run('DELETE FROM config_event WHERE project = ?', ['proj-rev-3']);
            }, /BR-06/);
        });

        it('AC-EV-02-04 / ED1: Empty window returns marked_artifacts: [] with window timestamps, 0 error', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-rev-empty',
                event_id: 'save-empty',
                version: 7,
                at: pubAt,
            });

            const res = await revertConfig(db, {
                project: 'proj-rev-empty',
                event_id: 'save-empty',
                at: revAt,
            });

            assert.deepEqual(res.marked_artifacts, []);
            assert.equal(res.window.from, pubAt);
            assert.equal(res.window.to, revAt);
        });

        it('AC-EV-02-05 / ED10: Deleted artefact within window is flagged artefact_state: deleted with 0 crash', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const midAt = '2026-11-04T01:30:00.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-rev-del',
                event_id: 'save-del',
                version: 4,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-rev-del',
                turn_id: 'turn-del',
                at: midAt,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: {
                    artifacts: [{ id: 'art-gone', deleted: true, artefact_state: 'deleted' }],
                },
            }, { isRuntime: true });

            const res = await revertConfig(db, {
                project: 'proj-rev-del',
                event_id: 'save-del',
                revert_event_id: 'rev-del-evt',
                at: revAt,
            });

            assert.equal(res.marked_artifacts.length, 1);
            const marked = res.marked_artifacts[0];
            assert.equal(marked.artefact_id, 'art-gone');
            assert.equal(marked.marked, true);
            assert.equal(marked.artefact_state, 'deleted');
            assert.equal(marked.DANGLING_ARTEFACT, true);
            assert.equal(marked.dangling, true);
        });

        it('Boundary tests: exact lower bound [publish.at] is INCLUDED', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-bound',
                event_id: 'save-bound',
                version: 9,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-bound',
                turn_id: 'turn-exact-lower',
                at: pubAt, // exactly at lower bound
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: ['art-lower-bound'] },
            }, { isRuntime: true });

            const res = await revertConfig(db, {
                project: 'proj-bound',
                event_id: 'save-bound',
                at: revAt,
            });

            assert.equal(res.marked_artifacts.length, 1);
            assert.equal(res.marked_artifacts[0].artefact_id, 'art-lower-bound');
        });

        it('Idempotency & computeMarkedArtefacts: repeating revert on same event_id produces identical result and picks up late outbox turns', async () => {
            const pubAt = '2026-11-04T01:00:00.000Z';
            const midAt1 = '2026-11-04T01:15:00.000Z';
            const midAt2 = '2026-11-04T01:45:00.000Z';
            const revAt = '2026-11-04T02:00:00.000Z';

            await recordConfigSave(db, {
                project: 'proj-idemp',
                event_id: 'save-idemp',
                version: 8,
                at: pubAt,
            });

            await recordTurn(db, {
                project: 'proj-idemp',
                turn_id: 'turn-early',
                at: midAt1,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: ['art-early'] },
            }, { isRuntime: true });

            const res1 = await revertConfig(db, {
                project: 'proj-idemp',
                event_id: 'save-idemp',
                revert_event_id: 'rev-fixed-id',
                at: revAt,
            });

            const res2 = await revertConfig(db, {
                project: 'proj-idemp',
                event_id: 'save-idemp',
                revert_event_id: 'rev-fixed-id',
                at: revAt,
            });

            assert.deepEqual(res1.marked_artifacts, res2.marked_artifacts);

            // Now late arriving turn arrives (via outbox flush)
            await recordTurn(db, {
                project: 'proj-idemp',
                turn_id: 'turn-late',
                at: midAt2,
                level: 'sufficient',
                mode: 'do',
                basis: 'verified',
                payload: { artifacts: ['art-late'] },
            }, { isRuntime: true });

            const recomputed = await computeMarkedArtefacts(db, {
                project: 'proj-idemp',
                revert_event_id: 'rev-fixed-id',
            });

            assert.equal(recomputed.length, 2, 'Dynamic recomputation must include late-arriving turns');
            assert(recomputed.some((a) => a.artefact_id === 'art-early'));
            assert(recomputed.some((a) => a.artefact_id === 'art-late'));
        });
    });
});
