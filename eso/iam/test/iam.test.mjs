import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    initIamSchema,
    createWorker,
    retireWorker,
    listWorkers,
    createRole,
    changeWorkerRole,
    evaluateRoleSufficiency,
    checkRolePolicies,
    savePolicy,
    evaluatePolicies,
    handoverWorkerWork,
    checkFlowDanglingWorkers,
    CLOSED_VERBS,
    CLOSED_ATTRIBUTES,
} from '../src/index.mjs';

import { createTestPgDb } from '../../../qc/helpers/test-pg-db.mjs';

async function createTestDb() {
    return (await createTestPgDb()).db;
}


describe('ESO IAM Worker Domain (Slice S1 / ESO-176 / US-IAM-01)', () => {
    it('Schema: creates worker and role tables and enforces schema constraints', async () => {
        const db = await createTestDb();
        await initIamSchema(db);

        await db.run(
            `INSERT INTO worker (project, worker_id, role_name, harness_source, state)
             VALUES (?, ?, ?, ?, ?)`,
            ['proj-1', 'worker-01', 'build', 'eso-native', 'active']
        );

        const row = await db.get(`SELECT * FROM worker WHERE project = ? AND worker_id = ?`, ['proj-1', 'worker-01']);
        assert.ok(row);
        assert.equal(row.project, 'proj-1');
        assert.equal(row.state, 'active');
    });

    it('AC-IAM-01-01: Registers worker with role and project, starts in active state with exactly 1 role', () => {
        const catalog = [
            { name: 'build', status: 'current' },
            { name: 'qc', status: 'current' },
        ];

        const worker = createWorker({
            project: 'baplatform',
            worker_id: 'w-alpha',
            role: 'build',
            harness_source: 'eso-native',
            catalogRoles: catalog,
        });

        assert.equal(worker.project, 'baplatform');
        assert.equal(worker.worker_id, 'w-alpha');
        assert.equal(worker.role_name, 'build');
        assert.equal(worker.state, 'active');
        assert.equal(worker.harness_source, 'eso-native');
    });

    it('AC-IAM-01-02: Active worker with unfinished tasks retired -> tasks become OPEN risk entries with owner + review_by', () => {
        const worker = {
            project: 'baplatform',
            worker_id: 'w-active-retiring',
            role_name: 'build',
            state: 'active',
        };

        const activeWork = [
            { task_id: 'T-101', what: 'Implement user auth API slice', owner: 'w-active-retiring' },
            { task_id: 'T-102', what: 'Fix memory leak in websocket listener', owner: 'w-active-retiring' },
        ];

        const retired = retireWorker({
            worker,
            activeWork,
            reviewer: 'operator-alice',
        });

        assert.equal(retired.state, 'retired');
        assert.equal(retired.open_risks.length, 2);

        const r1 = retired.open_risks[0];
        assert.equal(r1.status, 'OPEN');
        assert.equal(r1.review_by, 'operator-alice');
        assert.equal(r1.task_id, 'T-101');
        assert.equal(r1.what, 'Implement user auth API slice');
    });

    it('AC-IAM-01-03: Role not found in catalog halts with UNKNOWN_ROLE (0 workers created)', () => {
        const catalog = [
            { name: 'build', status: 'current' },
            { name: 'qc', status: 'current' },
        ];

        assert.throws(() => {
            createWorker({
                project: 'baplatform',
                worker_id: 'w-invalid-role',
                role: 'unknown-architect',
                catalogRoles: catalog,
            });
        }, (err) => {
            assert.equal(err.code, 'UNKNOWN_ROLE');
            assert.equal(err.role, 'unknown-architect');
            return true;
        });
    });

    it('AC-IAM-01-04: ED1 — Team with 0 workers lists clean empty array without error', () => {
        const list = listWorkers({ workers: [], project: 'baplatform' });
        assert.deepEqual(list, []);
    });

    it('AC-IAM-01-05: ED6 — Creating worker with duplicate ID halts with DUPLICATE_ID (only 1 survives)', () => {
        const existing = [
            { project: 'baplatform', worker_id: 'w-existing-01', role_name: 'build', state: 'active' },
        ];

        assert.throws(() => {
            createWorker({
                project: 'baplatform',
                worker_id: 'w-existing-01', // Duplicate!
                role: 'build',
                existingWorkers: existing,
            });
        }, (err) => {
            assert.equal(err.code, 'DUPLICATE_ID');
            assert.equal(err.worker_id, 'w-existing-01');
            return true;
        });
    });

    describe('ESO IAM Role, Scope & Bar Domain (Slice S1 / ESO-181 / US-IAM-02)', () => {
        it('AC-IAM-02-01: Creates open role with custom name, capabilities, scope, and bar (evidence_kind + min_basis)', () => {
            const role = createRole({
                project: 'baplatform',
                name: 'designer-lead',
                version: 1,
                capabilities: ['design', 'review'],
                scope: [
                    { verb: 'read', kind: 'file', value: 'designs/**' },
                    { verb: 'write', kind: 'file', value: 'designs/spec/**' },
                ],
                bar: [
                    { evidence_kind: 'figma-link', min_basis: 'full' },
                ],
            });

            assert.equal(role.name, 'designer-lead');
            assert.deepEqual(role.capabilities, ['design', 'review']);
            assert.equal(role.scope.length, 2);
            assert.equal(role.bar.length, 1);
            assert.equal(role.bar[0].evidence_kind, 'figma-link');
        });

        it('AC-IAM-02-02: Agent role with empty bar is rejected with EMPTY_OBLIGATION', () => {
            assert.throws(() => {
                createRole({
                    project: 'baplatform',
                    name: 'empty-obligation-agent',
                    capabilities: ['build'],
                    bar: [], // Empty bar!
                });
            }, (err) => {
                assert.equal(err.code, 'EMPTY_OBLIGATION');
                return true;
            });
        });

        it('AC-IAM-02-03: Two roles with different bar yield different level verdicts differing exactly on bar requirement', () => {
            const roleLenient = {
                name: 'scout-worker',
                bar: [{ evidence_kind: 'test-log', min_basis: 'partial' }],
            };
            const roleStrict = {
                name: 'audit-worker',
                bar: [
                    { evidence_kind: 'test-log', min_basis: 'partial' },
                    { evidence_kind: 'qc-report', min_basis: 'full' },
                ],
            };

            const evidence = [
                { kind: 'test-log', basis: 'partial' },
            ];

            const v1 = evaluateRoleSufficiency({ role: roleLenient, evidence });
            const v2 = evaluateRoleSufficiency({ role: roleStrict, evidence });

            assert.equal(v1.level, 'SUFFICIENT');
            assert.equal(v2.level, 'INSUFFICIENT');
            assert.equal(v2.deficits.length, 1);
            assert.equal(v2.deficits[0].evidence_kind, 'qc-report');
        });

        it('AC-IAM-02-04: Agent actor attempting to change worker role rejected with ROLE_CHANGE_FORBIDDEN', () => {
            const worker = {
                worker_id: 'w-target',
                role_name: 'build',
            };

            assert.throws(() => {
                changeWorkerRole({
                    worker,
                    newRole: 'lead',
                    actor: 'agent', // Not operator!
                });
            }, (err) => {
                assert.equal(err.code, 'ROLE_CHANGE_FORBIDDEN');
                return true;
            });

            // Allowed for operator
            const updated = changeWorkerRole({
                worker,
                newRole: 'lead',
                actor: 'operator',
            });
            assert.equal(updated.role_name, 'lead');
        });

        it('AC-IAM-02-05: Scope with verb outside closed set rejected with UNKNOWN_VERB', () => {
            assert.throws(() => {
                createRole({
                    project: 'baplatform',
                    name: 'custom-role',
                    capabilities: ['build'],
                    bar: [{ evidence_kind: 'diff', min_basis: 'full' }],
                    scope: [
                        { verb: 'deploy_to_prod', kind: 'file', value: '*' }, // Unknown verb!
                    ],
                });
            }, (err) => {
                assert.equal(err.code, 'UNKNOWN_VERB');
                assert.equal(err.verb, 'deploy_to_prod');
                return true;
            });
        });

        it('AC-IAM-02-06: Agent role with empty capabilities rejected with EMPTY_ROLE', () => {
            assert.throws(() => {
                createRole({
                    project: 'baplatform',
                    name: 'agent-no-caps',
                    capabilities: [], // Empty!
                    bar: [{ evidence_kind: 'diff', min_basis: 'full' }],
                });
            }, (err) => {
                assert.equal(err.code, 'EMPTY_ROLE');
                return true;
            });
        });

        it('AC-IAM-02-07: Role referencing missing or deleted policy reports DANGLING_POLICY', () => {
            const role = {
                name: 'build-worker',
                policies: ['policy-active', 'policy-deleted'],
            };

            const availablePolicies = [
                { name: 'policy-active', status: 'current' },
                { name: 'policy-deleted', status: 'deleted' },
            ];

            const check = checkRolePolicies({ role, availablePolicies });
            assert.equal(check.valid, false);
            assert.equal(check.code, 'DANGLING_POLICY');
            assert.deepEqual(check.dangling, ['policy-deleted']);
        });
    });

    describe('ESO IAM Policy & Deny-Overrides Domain (Slice S1 / ESO-186 / US-IAM-03)', () => {
        it('AC-IAM-03-01: Deny-overrides combining algorithm: allow and deny match => deny wins', () => {
            const policies = [
                {
                    policy_id: 'pol-allow',
                    project: 'baplatform',
                    attribute: 'stage',
                    operator: 'eq',
                    value: 'dev',
                    effect: 'allow',
                },
                {
                    policy_id: 'pol-deny',
                    project: 'baplatform',
                    attribute: 'path',
                    operator: 'starts_with',
                    value: 'secrets/',
                    effect: 'deny',
                },
            ];

            const target = {
                project: 'baplatform',
                stage: 'dev',
                path: 'secrets/prod-key.pem',
            };

            const result = evaluatePolicies({
                project: 'baplatform',
                target,
                policies,
            });

            assert.equal(result.effect, 'deny');
            assert.equal(result.decided_by, 'pol-deny');
            assert.equal(result.matched.length, 2);
        });

        it('AC-IAM-03-02: Agent attempting to change policy directly or indirectly is rejected with POLICY_CHANGE_FORBIDDEN', () => {
            const policy = {
                policy_id: 'pol-01',
                attribute: 'stage',
                operator: 'eq',
                value: 'prod',
                effect: 'deny',
            };

            // Direct agent change
            assert.throws(() => {
                savePolicy({
                    project: 'baplatform',
                    policy,
                    actor: 'agent',
                    channel: 'direct',
                });
            }, (err) => {
                assert.equal(err.code, 'POLICY_CHANGE_FORBIDDEN');
                assert.equal(err.channel, 'direct');
                return true;
            });

            // Indirect agent change (via subagent or delegated task)
            assert.throws(() => {
                savePolicy({
                    project: 'baplatform',
                    policy,
                    actor: 'subagent-build',
                    channel: 'indirect',
                });
            }, (err) => {
                assert.equal(err.code, 'POLICY_CHANGE_FORBIDDEN');
                assert.equal(err.channel, 'indirect');
                return true;
            });
        });

        it('AC-IAM-03-03: Policy with unknown attribute rejected at save time with UNKNOWN_ATTRIBUTE (0 writes)', () => {
            const policy = {
                policy_id: 'pol-unknown-attr',
                attribute: 'unregistered_field',
                operator: 'eq',
                value: 'bad',
                effect: 'deny',
            };

            assert.throws(() => {
                savePolicy({
                    project: 'baplatform',
                    policy,
                    actor: 'operator',
                });
            }, (err) => {
                assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
                assert.equal(err.attribute, 'unregistered_field');
                return true;
            });
        });

        it('AC-IAM-03-04: Multi-tenant: project A policies do not apply to project B (0 matched policies)', () => {
            const policies = [
                {
                    policy_id: 'pol-proj-a',
                    project: 'proj-A',
                    attribute: 'stage',
                    operator: 'eq',
                    value: 'prod',
                    effect: 'deny',
                },
            ];

            const result = evaluatePolicies({
                project: 'proj-B',
                target: { project: 'proj-B', stage: 'prod' },
                policies,
            });

            assert.equal(result.matched.length, 0);
            assert.equal(result.reason, 'NO_MATCHING_POLICY');
        });

        it('AC-IAM-03-05 / ED7: Saving policy with stale version rejected with STALE_VERSION', () => {
            const prevPolicy = {
                policy_id: 'pol-01',
                version: 3,
            };

            const incomingPolicy = {
                policy_id: 'pol-01',
                version: 2, // Stale!
                attribute: 'stage',
            };

            assert.throws(() => {
                savePolicy({
                    project: 'baplatform',
                    policy: incomingPolicy,
                    previousPolicy: prevPolicy,
                    actor: 'operator',
                });
            }, (err) => {
                assert.equal(err.code, 'STALE_VERSION');
                assert.equal(err.version, 2);
                return true;
            });
        });

        it('AC-IAM-03-06 / ED10: Policy referencing deleted/missing attribute surfaces DANGLING_ATTRIBUTE', () => {
            const policy = {
                policy_id: 'pol-dangling',
                project: 'baplatform',
                attribute: 'deleted_attr',
                operator: 'eq',
                value: 'x',
                effect: 'deny',
            };

            const result = evaluatePolicies({
                project: 'baplatform',
                target: { project: 'baplatform', deleted_attr: 'x' },
                policies: [policy],
                availableAttributes: ['stage', 'path'], // deleted_attr missing!
            });

            assert.equal(result.dangling_attributes.length, 1);
            assert.equal(result.dangling_attributes[0].code, 'DANGLING_ATTRIBUTE');
        });

        it('AC-IAM-03-07: Out-of-scope project target rejected with OUT_OF_SCOPE', () => {
            assert.throws(() => {
                evaluatePolicies({
                    project: 'proj-alpha',
                    target: { project: 'proj-beta' }, // foreign project!
                    policies: [],
                });
            }, (err) => {
                assert.equal(err.code, 'OUT_OF_SCOPE');
                return true;
            });
        });
    });

    describe('ESO IAM Worker Handover & Flow Integrity (Slice S1 / ESO-315 / US-IAM-07)', () => {
        it('AC-IAM-07-01: Worker with work and designated recipient transfers tasks and records handover', () => {
            const activeWorker = {
                worker_id: 'w-active-retiring',
                project: 'baplatform',
                state: 'active',
            };
            const tasks = [
                { task_id: 't-1', what: 'Design DB schema' },
                { task_id: 't-2', what: 'Write unit tests' },
            ];

            const result = handoverWorkerWork({
                worker: activeWorker,
                activeWork: tasks,
                recipient: 'w-new-owner',
            });

            assert.equal(result.state, 'retired');
            assert.ok(result.handover_record);
            assert.equal(result.handover_record.from_worker, 'w-active-retiring');
            assert.equal(result.handover_record.to_worker, 'w-new-owner');
            assert.equal(result.transferred_work.length, 2);
            assert.equal(result.transferred_work[0].owner, 'w-new-owner');
            assert.equal(result.transferred_work[0].previous_owner, 'w-active-retiring');
        });

        it('AC-IAM-07-02: Worker with work, no recipient and no open risk flag is rejected with RETIRE_WITH_WORK', () => {
            const activeWorker = {
                worker_id: 'w-stuck-work',
                project: 'baplatform',
                state: 'active',
            };
            const tasks = [{ task_id: 't-1' }];

            assert.throws(() => {
                handoverWorkerWork({
                    worker: activeWorker,
                    activeWork: tasks,
                    recipient: null,
                    allowOpenRisk: false,
                });
            }, (err) => {
                assert.equal(err.code, 'RETIRE_WITH_WORK');
                assert.equal(err.work_count, 1);
                return true;
            });
        });

        it('AC-IAM-07-03: Retired worker still referenced in flow surfaces DANGLING_FLOW', () => {
            const workers = [
                { worker_id: 'w-active', state: 'active' },
                { worker_id: 'w-retired', state: 'retired' },
            ];
            const flow = {
                name: 'pr-review-flow',
                steps: [
                    { id: 'step-1', worker_id: 'w-active' },
                    { id: 'step-2', worker_id: 'w-retired' },
                ],
            };

            const result = checkFlowDanglingWorkers({ flow, workers });
            assert.equal(result.valid, false);
            assert.equal(result.code, 'DANGLING_FLOW');
            assert.equal(result.dangling_workers.length, 1);
            assert.equal(result.dangling_workers[0].worker_id, 'w-retired');
        });

        it('AC-IAM-07-04 / ED6: Retiring already inactive/retired worker rejected with ALREADY_INACTIVE', () => {
            const retiredWorker = {
                worker_id: 'w-already-retired',
                state: 'retired',
            };

            assert.throws(() => {
                handoverWorkerWork({
                    worker: retiredWorker,
                });
            }, (err) => {
                assert.equal(err.code, 'ALREADY_INACTIVE');
                return true;
            });
        });

        it('AC-IAM-07-05 / ED7: Concurrent retire attempt on active handover results in exactly one winner', () => {
            let workerState = {
                worker_id: 'w-race-handover',
                state: 'active',
            };
            const tasks = [{ task_id: 't-critical' }];

            // Handover 1 succeeds
            const h1 = handoverWorkerWork({
                worker: workerState,
                activeWork: tasks,
                recipient: 'w-first-winner',
            });
            assert.equal(h1.state, 'retired');
            assert.equal(h1.transferred_work[0].owner, 'w-first-winner');

            // Update state
            workerState = h1;

            // Handover 2 fails
            assert.throws(() => {
                handoverWorkerWork({
                    worker: workerState,
                    activeWork: tasks,
                    recipient: 'w-second-caller',
                });
            }, (err) => {
                assert.equal(err.code, 'ALREADY_INACTIVE');
                return true;
            });

            // Single owner preserved
            assert.equal(h1.transferred_work[0].owner, 'w-first-winner');
        });
    });
});
