/**
 * Unit tests for @mu/eso-control-plane (Ticket ESO-90 / Slice S1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkFileWriteScope,
    executeFileWrite,
    transitionTaskStatus,
    queryTaskJudgement,
} from '../src/modules/scope/domain/scope.ts';

describe('@mu/eso-control-plane — Scope Guard Unit Tests (Slice S1)', () => {
    describe('AC-AGENT-01-01 & AC-AGENT-01-04: File write scope enforcement', () => {
        it('AC-AGENT-01-04: allows file write when target matches allowed_files', () => {
            let writtenPath = null;
            let writtenContent = null;
            const mockWrite = (path, content) => {
                writtenPath = path;
                writtenContent = content;
            };

            const res = executeFileWrite({
                allowedFiles: ['src/services/**', 'src/dtos/*.ts'],
                targetPath: 'src/services/order.ts',
                content: 'export class OrderService {}',
                writeFileFn: mockWrite,
            });

            assert.equal(res.success, true);
            assert.equal(writtenPath, 'src/services/order.ts');
            assert.equal(writtenContent, 'export class OrderService {}');
        });

        it('AC-AGENT-01-01: refuses file write outside allowed_files with BLOCKED_SCOPE without modifying disk', () => {
            let writeCalled = false;
            const mockWrite = () => { writeCalled = true; };
            const refusals = [];
            const logRefusal = (r) => refusals.push(r);

            assert.throws(() => {
                executeFileWrite({
                    allowedFiles: ['eso/graph/**'],
                    targetPath: 'packages/harness-foundation/src/core.mjs',
                    content: 'modified content',
                    writeFileFn: mockWrite,
                    logRefusalFn: logRefusal,
                });
            }, (err) => {
                return err.code === 'BLOCKED_SCOPE';
            });

            assert.equal(writeCalled, false, 'writeFileFn must NOT be invoked on BLOCKED_SCOPE');
            assert.equal(refusals.length, 1);
            assert.equal(refusals[0].error, 'BLOCKED_SCOPE');
            assert.equal(refusals[0].targetPath, 'packages/harness-foundation/src/core.mjs');
        });
    });

    describe('AC-AGENT-01-02: Agent Done transition prohibition (SLP Role Gate)', () => {
        it('refuses agent transition to Done with DONE_FORBIDDEN and logs refusal', () => {
            const refusals = [];
            const logRefusal = (r) => refusals.push(r);

            assert.throws(() => {
                transitionTaskStatus({
                    currentStatus: 'In Review',
                    newStatus: 'Done',
                    actorRole: 'agent',
                    logRefusalFn: logRefusal,
                });
            }, (err) => {
                return err.code === 'DONE_FORBIDDEN';
            });

            assert.equal(refusals.length, 1);
            assert.equal(refusals[0].error, 'DONE_FORBIDDEN');
            assert.equal(refusals[0].currentStatus, 'In Review');
        });

        it('allows human / operator to transition to Done', () => {
            const res = transitionTaskStatus({
                currentStatus: 'Human In Review',
                newStatus: 'Done',
                actorRole: 'human',
            });

            assert.equal(res.success, true);
            assert.equal(res.status, 'Done');
        });
    });

    describe('AC-AGENT-01-03: Scope refusal without existence leakage', () => {
        it('returns identical OUT_OF_SCOPE refusal whether item exists or does not exist', () => {
            const taskStore = new Map([
                ['task-secret', { name: 'Super Secret Task', payload: 'classified' }],
            ]);

            const agentScope = ['task-public-1', 'task-public-2'];

            // Query existing item outside scope
            let errExisting = null;
            try {
                queryTaskJudgement({ agentScope, taskId: 'task-secret', taskStore });
            } catch (err) {
                errExisting = err;
            }

            // Query non-existent item outside scope
            let errNonExistent = null;
            try {
                queryTaskJudgement({ agentScope, taskId: 'task-ghost-404', taskStore });
            } catch (err) {
                errNonExistent = err;
            }

            assert.ok(errExisting);
            assert.ok(errNonExistent);
            assert.equal(errExisting.code, 'OUT_OF_SCOPE');
            assert.equal(errNonExistent.code, 'OUT_OF_SCOPE');
            assert.equal(errExisting.message, errNonExistent.message, 'Refusal message must NOT leak item existence');
        });
    });

    describe('AC-AGENT-01-05 & AC-AGENT-01-06: Edge cases ED1 & ED10', () => {
        it('AC-AGENT-01-05 / ED1: empty allowed_files refuses with EMPTY_SCOPE', () => {
            const check = checkFileWriteScope({
                allowedFiles: [],
                targetPath: 'src/any.ts',
            });

            assert.equal(check.allowed, false);
            assert.equal(check.error, 'EMPTY_SCOPE');
            assert.ok(check.message.includes('empty'));
        });

        it('AC-AGENT-01-06 / ED10: target path in deleted/missing directory refuses with DANGLING_SCOPE', () => {
            const mockDirExists = (dir) => dir === 'existing/dir';

            const check = checkFileWriteScope({
                allowedFiles: ['deleted/dir/**'],
                targetPath: 'deleted/dir/file.ts',
                dirExists: mockDirExists,
            });

            assert.equal(check.allowed, false);
            assert.equal(check.error, 'DANGLING_SCOPE');
            assert.ok(check.message.includes('deleted'));
        });
    });
});
