import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkFileWriteScope,
    executeFileWrite,
    transitionTaskStatus,
    queryTaskJudgement,
} from '../eso/control-plane/src/modules/scope/domain/scope.ts';

test('SCN-CP-01 (AC-AGENT-01-01 & AC-AGENT-01-04): Enforces locked allowed_files boundary; refuses out-of-scope with BLOCKED_SCOPE', () => {
    let diskModified = false;
    const mockWrite = () => { diskModified = true; };
    const refusalAuditLog = [];
    const logger = (r) => refusalAuditLog.push(r);

    const allowedFiles = [
        'eso/control-plane/**',
        'qc/eso-cp-*.test.mjs',
    ];

    // Case 1: In-scope file write succeeds (AC-AGENT-01-04)
    const valid = executeFileWrite({
        allowedFiles,
        targetPath: 'eso/control-plane/src/worker.mjs',
        content: '// valid code',
        writeFileFn: mockWrite,
        logRefusalFn: logger,
    });
    assert.equal(valid.success, true);
    assert.equal(diskModified, true);

    // Reset disk modified flag
    diskModified = false;

    // Case 2: Out-of-scope file write rejected without modifying disk (AC-AGENT-01-01)
    assert.throws(() => {
        executeFileWrite({
            allowedFiles,
            targetPath: 'packages/harness-foundation/src/index.mjs',
            content: '// forbidden write',
            writeFileFn: mockWrite,
            logRefusalFn: logger,
        });
    }, (err) => {
        return err.code === 'BLOCKED_SCOPE';
    });

    assert.equal(diskModified, false, 'Disk must NOT be touched on BLOCKED_SCOPE refusal');
    assert.equal(refusalAuditLog.length, 1);
    assert.equal(refusalAuditLog[0].error, 'BLOCKED_SCOPE');
    assert.equal(refusalAuditLog[0].targetPath, 'packages/harness-foundation/src/index.mjs');
});

test('SCN-CP-02 (AC-AGENT-01-02): Agent is strictly prohibited from marking tasks as Done (DONE_FORBIDDEN)', () => {
    const refusalLogs = [];
    const logger = (r) => refusalLogs.push(r);

    // Agent attempts to sign Done
    assert.throws(() => {
        transitionTaskStatus({
            currentStatus: 'In Review',
            newStatus: 'Done',
            actorRole: 'agent',
            logRefusalFn: logger,
        });
    }, (err) => {
        return err.code === 'DONE_FORBIDDEN';
    });

    assert.equal(refusalLogs.length, 1);
    assert.equal(refusalLogs[0].error, 'DONE_FORBIDDEN');
    assert.equal(refusalLogs[0].currentStatus, 'In Review');

    // Operator signs Done -> succeeds
    const operatorResult = transitionTaskStatus({
        currentStatus: 'Human In Review',
        newStatus: 'Done',
        actorRole: 'human',
    });
    assert.equal(operatorResult.success, true);
    assert.equal(operatorResult.status, 'Done');
});

test('SCN-CP-03 (AC-AGENT-01-03): Refusal of out-of-scope work item does not leak whether item exists', () => {
    const internalStore = {
        'task-internal-secret': { title: 'Secret Vulnerability Fix', isPrivate: true },
    };

    const agentScope = ['task-public-101'];

    // Query secret task
    let errA = null;
    try {
        queryTaskJudgement({
            agentScope,
            taskId: 'task-internal-secret',
            taskStore: internalStore,
        });
    } catch (e) {
        errA = e;
    }

    // Query non-existent task
    let errB = null;
    try {
        queryTaskJudgement({
            agentScope,
            taskId: 'task-completely-bogus-404',
            taskStore: internalStore,
        });
    } catch (e) {
        errB = e;
    }

    assert.ok(errA && errB);
    assert.equal(errA.code, 'OUT_OF_SCOPE');
    assert.equal(errB.code, 'OUT_OF_SCOPE');
    assert.equal(errA.message, errB.message, 'Must return identical refusal message to prevent probing');
});

test('SCN-CP-04 (AC-AGENT-01-05 & ED1): Empty allowed_files scope refuses all writes with EMPTY_SCOPE', () => {
    const check = checkFileWriteScope({
        allowedFiles: [],
        targetPath: 'eso/control-plane/src/any.mjs',
    });

    assert.equal(check.allowed, false);
    assert.equal(check.error, 'EMPTY_SCOPE');
    assert.ok(check.message.includes('empty'));
});

test('SCN-CP-05 (AC-AGENT-01-06 & ED10): Target file in deleted directory is rejected with DANGLING_SCOPE', () => {
    const mockDirExists = (dir) => false; // directory deleted

    const check = checkFileWriteScope({
        allowedFiles: ['eso/deleted-folder/**'],
        targetPath: 'eso/deleted-folder/script.mjs',
        dirExists: mockDirExists,
    });

    assert.equal(check.allowed, false);
    assert.equal(check.error, 'DANGLING_SCOPE');
    assert.ok(check.message.includes('deleted'));
});
