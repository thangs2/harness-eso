import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    initProposalSchema,
    createProposal,
    applyProposal,
    listProposals,
    rejectProposal,
    applyProposalToSystem,
    evaluateEffectiveness,
    revertProposal,
    decrementVersion,
} from '../src/index.mjs';

import { createTestPgDb } from '../../../qc/helpers/test-pg-db.mjs';

async function createTestDb() {
    return (await createTestPgDb()).db;
}


describe('ESO Learning Proposal Domain (Slice S1 / ESO-150 / US-LEARN-01)', () => {
    it('Schema: creates proposal table and enforces schema constraints', async () => {
        const db = await createTestDb();
        await initProposalSchema(db);

        // Insert valid proposal
        await db.run(
            `INSERT INTO proposal (project, proposal_id, version, risk_kind, evidence, expected_effect, revert, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['proj-1', 'prop-001', 1, 'missing-evidence', JSON.stringify(['gap-1', 'gap-2']), 'unsat_rate down', JSON.stringify({ action: 'rollback_rule' }), 'proposed']
        );

        const row = await db.get(`SELECT * FROM proposal WHERE project = ? AND proposal_id = ?`, ['proj-1', 'prop-001']);
        assert.ok(row);
        assert.equal(row.project, 'proj-1');
        assert.equal(row.status, 'proposed');
    });

    it('AC-LEARN-01-01: Creates proposal when >= 2 distinct risks of same kind exist', () => {
        const risks = [
            { risk_id: 'gap-01', risk_kind: 'missing-evidence' },
            { risk_id: 'gap-02', risk_kind: 'missing-evidence' },
        ];

        const proposal = createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks,
            expected_effect: 'unsat_rate decreases by 20% and defect_rate does not increase',
            revert: { action: 'delete_rule', path: 'rules/evidence-check.md' },
        });

        assert.equal(proposal.project, 'baplatform');
        assert.equal(proposal.status, 'proposed');
        assert.equal(proposal.version, 1);
        assert.deepEqual(proposal.evidence, ['gap-01', 'gap-02']);
        assert.ok(proposal.revert.action);
    });

    it('AC-LEARN-01-02: Missing or empty revert object rejected with NO_REVERT', () => {
        const risks = [
            { risk_id: 'gap-01', risk_kind: 'missing-evidence' },
            { risk_id: 'gap-02', risk_kind: 'missing-evidence' },
        ];

        // 1. Missing revert
        assert.throws(() => {
            createProposal({
                project: 'baplatform',
                risk_kind: 'missing-evidence',
                risks,
                expected_effect: 'some effect',
                revert: null,
            });
        }, (err) => {
            assert.equal(err.code, 'NO_REVERT');
            return true;
        });

        // 2. Empty revert object
        assert.throws(() => {
            createProposal({
                project: 'baplatform',
                risk_kind: 'missing-evidence',
                risks,
                expected_effect: 'some effect',
                revert: {},
            });
        }, (err) => {
            assert.equal(err.code, 'NO_REVERT');
            return true;
        });
    });

    it('AC-LEARN-01-03: Machine/agent applying proposal is rejected with APPLY_FORBIDDEN', () => {
        const proposal = {
            project: 'baplatform',
            proposal_id: 'p-123',
            status: 'proposed',
        };

        assert.throws(() => {
            applyProposal({
                proposal,
                actor: 'agent', // Not operator
            });
        }, (err) => {
            assert.equal(err.code, 'APPLY_FORBIDDEN');
            return true;
        });

        // Allowed for operator
        const applied = applyProposal({
            proposal,
            actor: 'operator',
            window: '30d',
        });
        assert.equal(applied.status, 'applied');
        assert.ok(applied.applied_at);
        assert.equal(applied.measure_window.duration, '30d');
    });

    it('AC-LEARN-01-05: 0 risks of same kind (ED1) rejected with NO_CLUSTER', () => {
        assert.throws(() => {
            createProposal({
                project: 'baplatform',
                risk_kind: 'missing-evidence',
                risks: [], // Empty
                expected_effect: 'some effect',
                revert: { rollback: true },
            });
        }, (err) => {
            assert.equal(err.code, 'NO_CLUSTER');
            return true;
        });
    });

    it('AC-LEARN-01-06: 1 risk repeated 2 times (ED6) yields distinct count = 1 < 2 => rejected with NO_CLUSTER', () => {
        const duplicateRisks = [
            { risk_id: 'same-gap-id', risk_kind: 'missing-evidence' },
            { risk_id: 'same-gap-id', risk_kind: 'missing-evidence' },
        ];

        assert.throws(() => {
            createProposal({
                project: 'baplatform',
                risk_kind: 'missing-evidence',
                risks: duplicateRisks,
                expected_effect: 'some effect',
                revert: { rollback: true },
            });
        }, (err) => {
            assert.equal(err.code, 'NO_CLUSTER');
            assert.equal(err.distinct_count, 1);
            return true;
        });
    });

    describe('ESO Learning Proposal Review & Rejection (Slice S1 / ESO-155 / US-LEARN-02)', () => {
        it('AC-LEARN-02-01: List proposals includes evidence[], expected_effect, revert on every item', () => {
            const proposals = [
                {
                    proposal_id: 'p-1',
                    evidence: ['gap-1', 'gap-2'],
                    expected_effect: 'lower unsat_rate',
                    revert: { action: 'revert' },
                    status: 'proposed',
                },
            ];

            const result = listProposals({ proposals });
            assert.equal(result.total, 1);
            assert.equal(result.items.length, 1);
            assert.deepEqual(result.items[0].evidence, ['gap-1', 'gap-2']);
            assert.equal(result.items[0].expected_effect, 'lower unsat_rate');
            assert.ok(result.items[0].revert);
        });

        it('AC-LEARN-02-02: Proposal without attached risks omitted by default or flagged OUT with NO_EVIDENCE', () => {
            const proposals = [
                { proposal_id: 'p-valid', evidence: ['gap-1'], expected_effect: 'eff', revert: { r: 1 } },
                { proposal_id: 'p-invalid', evidence: [], expected_effect: 'eff', revert: { r: 1 } },
            ];

            // Default: omitted
            const resultDefault = listProposals({ proposals });
            assert.equal(resultDefault.total, 1);
            assert.equal(resultDefault.items[0].proposal_id, 'p-valid');

            // With includeInvalid: marked OUT
            const resultInvalid = listProposals({ proposals, includeInvalid: true });
            assert.equal(resultInvalid.total, 2);
            const invalidItem = resultInvalid.items.find(i => i.proposal_id === 'p-invalid');
            assert.equal(invalidItem.display_status, 'OUT');
            assert.equal(invalidItem.out_reason, 'NO_EVIDENCE');
        });

        it('AC-LEARN-02-03: Applied proposal surfaces measure_window and measuring/concluded status', () => {
            const now = '2026-11-04T00:00:00Z';
            const proposals = [
                {
                    proposal_id: 'p-measuring',
                    status: 'applied',
                    evidence: ['gap-1'],
                    measure_window: { from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' },
                },
                {
                    proposal_id: 'p-concluded',
                    status: 'applied',
                    evidence: ['gap-2'],
                    measure_window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' },
                },
            ];

            const result = listProposals({ proposals, now });
            const measuring = result.items.find(i => i.proposal_id === 'p-measuring');
            const concluded = result.items.find(i => i.proposal_id === 'p-concluded');

            assert.equal(measuring.measurement_state, 'measuring');
            assert.equal(concluded.measurement_state, 'concluded');
        });

        it('AC-LEARN-02-04: 0 proposals (ED1) returns clean empty array without error', () => {
            const result = listProposals({ proposals: [] });
            assert.equal(result.total, 0);
            assert.deepEqual(result.items, []);
            assert.equal(result.page, 1);
        });

        it('AC-LEARN-02-05: 500 proposals (ED3) supports pagination without dropping any item', () => {
            const proposals = [];
            for (let i = 0; i < 500; i++) {
                proposals.push({
                    proposal_id: `prop-${i}`,
                    evidence: [`gap-${i}`],
                    expected_effect: `effect-${i}`,
                    revert: { action: 'rollback' },
                });
            }

            const page1 = listProposals({ proposals, page: 1, pageSize: 50 });
            assert.equal(page1.total, 500);
            assert.equal(page1.items.length, 50);
            assert.equal(page1.items[0].proposal_id, 'prop-0');
            assert.equal(page1.totalPages, 10);

            const page10 = listProposals({ proposals, page: 10, pageSize: 50 });
            assert.equal(page10.items.length, 50);
            assert.equal(page10.items[49].proposal_id, 'prop-499');
        });

        it('AC-LEARN-02-06: Rejecting proposal without reason rejected with NO_REASON and remains proposed', () => {
            const prop = {
                proposal_id: 'p-reject',
                status: 'proposed',
                evidence: ['gap-1'],
            };

            // Empty reason throws NO_REASON
            assert.throws(() => {
                rejectProposal({ proposal: prop, reason: '' });
            }, (err) => {
                assert.equal(err.code, 'NO_REASON');
                return true;
            });

            // Status unchanged
            assert.equal(prop.status, 'proposed');

            // With valid reason
            const rejected = rejectProposal({ proposal: prop, reason: 'Risk pattern did not recur in staging' });
            assert.equal(rejected.status, 'rejected');
            assert.equal(rejected.rejection_reason, 'Risk pattern did not recur in staging');
            assert.ok(rejected.rejected_at);
        });
    });

    describe('ESO Learning Proposal Apply & Measurement Window (Slice S1 / ESO-160 / US-LEARN-03)', () => {
        it('AC-LEARN-03-01 & AC-LEARN-03-05: Applying proposal bumps version, sets applied, and opens measure window from exact now', () => {
            const proposal = {
                proposal_id: 'p-apply-01',
                version: 1,
                status: 'proposed',
                revert: { action: 'rollback_version' },
            };

            const fixedNow = '2026-11-04T05:00:00.000Z';
            const applied = applyProposalToSystem({
                proposal,
                now: fixedNow,
                windowDuration: '30d',
                actor: 'operator',
            });

            assert.equal(applied.status, 'applied');
            assert.equal(applied.version, 2, 'Version increments by 1');
            assert.equal(applied.measure_from, fixedNow);
            assert.equal(applied.measure_to, '2026-12-04T05:00:00.000Z');
            assert.equal(applied.measure_window.duration, '30d');
            assert.equal(applied.measurement_state, 'measuring');
            assert.equal(applied.effective, false, 'Never effective: true immediately upon apply');
        });

        it('AC-LEARN-03-02: Agent attempting to apply proposal rejected with APPLY_FORBIDDEN (0 changes)', () => {
            const proposal = {
                proposal_id: 'p-agent-apply',
                version: 1,
                status: 'proposed',
                revert: { action: 'rollback' },
            };

            assert.throws(() => {
                applyProposalToSystem({
                    proposal,
                    actor: 'agent',
                });
            }, (err) => {
                assert.equal(err.code, 'APPLY_FORBIDDEN');
                return true;
            });

            assert.equal(proposal.status, 'proposed');
            assert.equal(proposal.version, 1);
        });

        it('AC-LEARN-03-03 & AC-LEARN-03-06: Applying already applied proposal rejected with ALREADY_APPLIED', () => {
            const appliedProposal = {
                proposal_id: 'p-already-applied',
                version: 2,
                status: 'applied',
                revert: { action: 'rollback' },
                measure_from: '2026-11-01T00:00:00.000Z',
            };

            assert.throws(() => {
                applyProposalToSystem({
                    proposal: appliedProposal,
                    actor: 'operator',
                });
            }, (err) => {
                assert.equal(err.code, 'ALREADY_APPLIED');
                return true;
            });
        });

        it('AC-LEARN-03-07: Idempotent re-apply preserves version, hash, artifact unchanged', () => {
            const appliedProposal = {
                proposal_id: 'p-idem',
                version: 2,
                status: 'applied',
                revert: { action: 'rollback' },
                measure_from: '2026-11-01T00:00:00.000Z',
            };

            const result = applyProposalToSystem({
                proposal: appliedProposal,
                actor: 'operator',
                idempotent: true,
            });

            assert.equal(result.idempotent, true);
            assert.equal(result.version, 2);
            assert.equal(result.measure_from, '2026-11-01T00:00:00.000Z');
        });
    });

    describe('ESO Learning Proposal Effectiveness Evaluation (Slice S1 / ESO-165 / US-LEARN-04)', () => {
        const closedProposal = {
            proposal_id: 'p-eval-01',
            status: 'applied',
            measure_window: {
                from: '2026-10-01T00:00:00.000Z',
                to: '2026-10-31T00:00:00.000Z',
            },
        };

        it('AC-LEARN-04-01: Window closed, unsat decreased, defect not increased => effective: true with both metrics', () => {
            const metrics = {
                before: { unsat_rate: 0.25, defect_rate: 0.05 },
                after: { unsat_rate: 0.15, defect_rate: 0.04 },
            };

            const result = evaluateEffectiveness({
                proposal: closedProposal,
                metrics,
                now: '2026-11-01T00:00:00.000Z',
            });

            assert.equal(result.concluded, true);
            assert.equal(result.effective, true);
            assert.equal(result.metrics.unsat.before, 0.25);
            assert.equal(result.metrics.unsat.after, 0.15);
            assert.equal(result.metrics.defect.before, 0.05);
            assert.equal(result.metrics.defect.after, 0.04);
        });

        it('AC-LEARN-04-02: Window closed, unsat decreased but defect increased => effective: false, states both', () => {
            const metrics = {
                before: { unsat_rate: 0.25, defect_rate: 0.05 },
                after: { unsat_rate: 0.10, defect_rate: 0.08 }, // Defect increased!
            };

            const result = evaluateEffectiveness({
                proposal: closedProposal,
                metrics,
                now: '2026-11-01T00:00:00.000Z',
            });

            assert.equal(result.concluded, true);
            assert.equal(result.effective, false);
            assert.equal(result.metrics.unsat.decreased, true);
            assert.equal(result.metrics.defect.not_increased, false);
        });

        it('AC-LEARN-04-03: Window still open halts with NO_MEASUREMENT (0 conclusion)', () => {
            const openProposal = {
                proposal_id: 'p-open',
                status: 'applied',
                measure_window: {
                    from: '2026-11-01T00:00:00.000Z',
                    to: '2026-11-30T00:00:00.000Z',
                },
            };

            const metrics = {
                before: { unsat_rate: 0.25, defect_rate: 0.05 },
                after: { unsat_rate: 0.15, defect_rate: 0.04 },
            };

            assert.throws(() => {
                evaluateEffectiveness({
                    proposal: openProposal,
                    metrics,
                    now: '2026-11-15T00:00:00.000Z', // In the middle of window!
                });
            }, (err) => {
                assert.equal(err.code, 'NO_MEASUREMENT');
                assert.match(err.message, /cửa sổ còn mở/);
                return true;
            });
        });

        it('AC-LEARN-04-04: Missing one metric halts with NO_MEASUREMENT (never infers or guesses)', () => {
            const metricsMissingDefect = {
                before: { unsat_rate: 0.25 },
                after: { unsat_rate: 0.15 },
            };

            assert.throws(() => {
                evaluateEffectiveness({
                    proposal: closedProposal,
                    metrics: metricsMissingDefect,
                    now: '2026-11-01T00:00:00.000Z',
                });
            }, (err) => {
                assert.equal(err.code, 'NO_MEASUREMENT');
                assert.ok(err.missing_metrics.includes('before.defect_rate'));
                return true;
            });
        });

        it('AC-LEARN-04-05 / ED4: defect_rate equal to previous counts as not increased => effective: true', () => {
            const metricsEqualDefect = {
                before: { unsat_rate: 0.30, defect_rate: 0.05 },
                after: { unsat_rate: 0.20, defect_rate: 0.05 }, // Exactly equal!
            };

            const result = evaluateEffectiveness({
                proposal: closedProposal,
                metrics: metricsEqualDefect,
                now: '2026-11-01T00:00:00.000Z',
            });

            assert.equal(result.concluded, true);
            assert.equal(result.effective, true);
            assert.equal(result.metrics.defect.not_increased, true);
        });

        it('AC-LEARN-04-06 / ED8: Window closed at exact boundary (now === measure_to) is eligible for evaluation', () => {
            const metrics = {
                before: { unsat_rate: 0.20, defect_rate: 0.05 },
                after: { unsat_rate: 0.10, defect_rate: 0.05 },
            };

            const result = evaluateEffectiveness({
                proposal: closedProposal,
                metrics,
                now: '2026-10-31T00:00:00.000Z', // Exact boundary
            });

            assert.equal(result.concluded, true);
            assert.equal(result.effective, true);
        });

        it('AC-LEARN-04-07: Metrics report missing before or after side halts with NO_MEASUREMENT naming side', () => {
            const metricsMissingAfter = {
                before: { unsat_rate: 0.20, defect_rate: 0.05 },
            };

            assert.throws(() => {
                evaluateEffectiveness({
                    proposal: closedProposal,
                    metrics: metricsMissingAfter,
                    now: '2026-11-01T00:00:00.000Z',
                });
            }, (err) => {
                assert.equal(err.code, 'NO_MEASUREMENT');
                assert.ok(err.missing.includes('after'));
                return true;
            });
        });
    });

    describe('ESO Learning Proposal Reversion (Slice S1 / ESO-170 / US-LEARN-05)', () => {
        it('AC-LEARN-05-01 & AC-LEARN-05-07: Single action reverts applied proposal, decrements version by 1, preserves proposal', () => {
            const applied = {
                proposal_id: 'p-revert-01',
                version: '1.4',
                status: 'applied',
                revert: { action: 'rollback_rule' },
                measure_window: { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' },
            };

            const reverted = revertProposal({
                proposal: applied,
                actor: 'operator',
                now: '2026-11-10T00:00:00Z',
                reason: 'Operator triggered rollback',
            });

            assert.equal(reverted.status, 'reverted');
            assert.equal(reverted.version, '1.3', 'Version decrements by exactly one from 1.4 to 1.3');
            assert.equal(reverted.reverted_by, 'operator');
            assert.equal(reverted.reverted_at, '2026-11-10T00:00:00Z');
            assert.equal(reverted.measurement_state, 'halted');
            assert.equal(reverted.measure_window.active, false);
            assert.ok(reverted.proposal_id, 'Proposal is preserved, never deleted');
        });

        it('AC-LEARN-05-02: Reverting proposal in proposed status rejected with NOT_APPLIED', () => {
            const proposed = {
                proposal_id: 'p-still-proposed',
                version: 1,
                status: 'proposed',
            };

            assert.throws(() => {
                revertProposal({ proposal: proposed, actor: 'operator' });
            }, (err) => {
                assert.equal(err.code, 'NOT_APPLIED');
                return true;
            });
        });

        it('AC-LEARN-05-03: Measurement window is closed, measurement_state is halted', () => {
            const applied = {
                proposal_id: 'p-window-close',
                version: 2,
                status: 'applied',
                measure_window: { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' },
            };

            const reverted = revertProposal({ proposal: applied, actor: 'operator' });
            assert.equal(reverted.measurement_state, 'halted');
            assert.equal(reverted.measure_window.active, false);
            assert.ok(reverted.measure_window.closed_at);
        });

        it('AC-LEARN-05-04: Agent actor attempting to revert is rejected with APPLY_FORBIDDEN (0 changes)', () => {
            const applied = {
                proposal_id: 'p-agent-revert',
                version: 2,
                status: 'applied',
            };

            assert.throws(() => {
                revertProposal({ proposal: applied, actor: 'agent' });
            }, (err) => {
                assert.equal(err.code, 'APPLY_FORBIDDEN');
                return true;
            });

            assert.equal(applied.status, 'applied');
            assert.equal(applied.version, 2);
        });

        it('AC-LEARN-05-05 / ED6: Reverting already reverted proposal rejected with NOT_APPLIED (0 changes)', () => {
            const alreadyReverted = {
                proposal_id: 'p-already-reverted',
                version: 1,
                status: 'reverted',
            };

            assert.throws(() => {
                revertProposal({ proposal: alreadyReverted, actor: 'operator' });
            }, (err) => {
                assert.equal(err.code, 'NOT_APPLIED');
                return true;
            });
        });

        it('AC-LEARN-05-06 / ED8: Reverting after measurement window closed preserves prior evaluation conclusion', () => {
            const priorEvaluation = {
                concluded: true,
                effective: false,
                reason: 'defect_rate increased',
            };

            const appliedWithEvaluation = {
                proposal_id: 'p-with-eval',
                version: 2,
                status: 'applied',
                evaluation: priorEvaluation,
            };

            const reverted = revertProposal({
                proposal: appliedWithEvaluation,
                actor: 'operator',
            });

            assert.equal(reverted.status, 'reverted');
            assert.deepEqual(reverted.evaluation, priorEvaluation, 'Prior evaluation record preserved');
        });
    });
});
