import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    validateAndCreateFlow,
    executeHandover,
    inspectFlowWorkers,
} from '../eso/control-plane/src/modules/flow/domain/flow.ts';

test('SCN-IAM-04-01 (AC-IAM-04-01): Flow A->B with evidence superset of bar(B) permits handover', () => {
    const flow = validateAndCreateFlow({
        id: 'flow-build-verify',
        project: 'baplatform',
        from: 'build',
        to: 'verify',
        carries: ['diff', 'allowed_files_report', 'rubric'],
    });

    assert.equal(flow.id, 'flow-build-verify');
    assert.equal(flow.steps.length, 1);

    const result = executeHandover({
        flow,
        fromRole: 'build',
        toRole: 'verify',
        carries: ['diff', 'allowed_files_report', 'rubric', 'extra_log'],
        targetRoleBar: ['diff', 'allowed_files_report'],
        targetRoleBarVersion: 2,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.unconstrained, false);
    assert.equal(result.from, 'build');
    assert.equal(result.to, 'verify');
    assert.equal(result.bar_version, 2);
    assert.ok(result.timestamp);
});

test('SCN-IAM-04-02 (AC-IAM-04-02): Missing required evidence blocks handover with HANDOFF_INCOMPLETE', () => {
    const flow = {
        id: 'flow-verify-audit',
        project: 'baplatform',
        from: 'verify',
        to: 'audit',
    };

    assert.throws(() => {
        executeHandover({
            flow,
            fromRole: 'verify',
            toRole: 'audit',
            carries: ['diff'], // missing 'verbatim_test_log'
            targetRoleBar: ['diff', 'verbatim_test_log'],
            targetRoleBarVersion: 1,
        });
    }, (err) => {
        assert.equal(err.code, 'HANDOFF_INCOMPLETE');
        assert.equal(err.allowed, false);
        assert.equal(err.from, 'verify');
        assert.equal(err.to, 'audit');
        assert.deepEqual(err.missing, ['verbatim_test_log']);
        assert.equal(err.required_by_role, 'audit');
        return true;
    });
});

test('SCN-IAM-04-03 (AC-IAM-04-03): Empty target bar allows handover with unconstrained: true', () => {
    const result = executeHandover({
        fromRole: 'lead',
        toRole: 'scout',
        carries: ['brief'],
        targetRoleBar: [], // unconstrained bar
        targetRoleBarVersion: 1,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.unconstrained, true);
    assert.equal(result.from, 'lead');
    assert.equal(result.to, 'scout');
});

test('SCN-IAM-04-04 (AC-IAM-04-04 / ED1): Flow with 0 steps is rejected with EMPTY_FLOW', () => {
    assert.throws(() => {
        validateAndCreateFlow({
            id: 'empty-flow',
            project: 'baplatform',
            steps: [],
        });
    }, (err) => {
        assert.equal(err.code, 'EMPTY_FLOW');
        return true;
    });
});

test('SCN-IAM-04-05 (AC-IAM-04-05 / ED6): Duplicate flow ID in same project rejected with DUPLICATE_ID', () => {
    const existing = [
        { id: 'flow-1', project: 'baplatform', steps: [{ from: 'a', to: 'b' }] },
    ];

    assert.throws(() => {
        validateAndCreateFlow({
            id: 'flow-1',
            project: 'baplatform',
            from: 'x',
            to: 'y',
            existingFlows: existing,
        });
    }, (err) => {
        assert.equal(err.code, 'DUPLICATE_ID');
        assert.equal(err.flow_id, 'flow-1');
        return true;
    });

    // Allowed in different project
    const diffProject = validateAndCreateFlow({
        id: 'flow-1',
        project: 'other-project',
        from: 'x',
        to: 'y',
        existingFlows: existing,
    });
    assert.equal(diffProject.id, 'flow-1');
    assert.equal(diffProject.project, 'other-project');
});

test('SCN-IAM-04-06 (AC-IAM-04-06): Cycle in flow (A->B->A or direct loop) rejected with FLOW_CYCLE', () => {
    // Direct self-cycle
    assert.throws(() => {
        validateAndCreateFlow({
            id: 'self-loop',
            project: 'baplatform',
            from: 'build',
            to: 'build',
        });
    }, (err) => {
        assert.equal(err.code, 'FLOW_CYCLE');
        return true;
    });

    // Indirect cycle A -> B -> A
    assert.throws(() => {
        validateAndCreateFlow({
            id: 'cycle-flow',
            project: 'baplatform',
            steps: [
                { from: 'scout', to: 'plan' },
                { from: 'plan', to: 'build' },
                { from: 'build', to: 'scout' },
            ],
        });
    }, (err) => {
        assert.equal(err.code, 'FLOW_CYCLE');
        return true;
    });
});

test('SCN-IAM-04-07 (AC-IAM-07-03): Flow reading flags retired worker as DANGLING_FLOW requiring edit or OPEN risk', () => {
    const flow = {
        id: 'flow-with-worker',
        project: 'baplatform',
        steps: [
            { from: 'build', to: 'verify', worker_id: 'worker-alice' },
            { from: 'verify', to: 'audit', worker_id: 'worker-bob' },
        ],
    };

    const workers = [
        { worker_id: 'worker-alice', state: 'active' },
        { worker_id: 'worker-bob', state: 'retired' },
    ];

    const inspected = inspectFlowWorkers({ flow, workers });
    assert.equal(inspected.has_retired_workers, true);
    assert.equal(inspected.code, 'DANGLING_FLOW');
    assert.equal(inspected.status, 'REQUIRES_EDIT_OR_OPEN_RISK');
    assert.equal(inspected.dangling_workers.length, 1);
    assert.equal(inspected.dangling_workers[0].worker_id, 'worker-bob');
    assert.equal(inspected.dangling_workers[0].worker_state, 'retired');
});
