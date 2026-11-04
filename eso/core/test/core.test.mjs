/**
 * @mu/eso-core — Unit Test Suite (Ticket ESO-95 / US-SUF-01 / Slice S1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    SOURCES,
    LEVELS,
    MODES,
    BASES,
    deriveRequirements,
    judgeSufficiency,
    formatOperatorExplanation,
    formatGapReport,
    explainTurnVerdict,
    emitProactiveWarning,
    applyOperatorBypass,
    isBypassExpired,
    getEffectiveMode,
    evaluateEffectiveVerdict,
} from '../src/index.mjs';

describe('@mu/eso-core — Sufficiency & Judgement Unit Tests (Slice S1)', () => {
    it('AC-SUF-01-01: Each requirement has level and basis, no aggregate replaces them', () => {
        const requirements = [
            { subject: 'service-auth', asks: 'contract', min_basis: 'retrieved', source: 'bar' },
            { subject: 'entity-user', asks: 'schema', min_basis: 'verified', source: 'work' },
        ];

        const answers = [
            { requirement: 'service-auth', claim: 'Auth contract v1', basis: 'retrieved', exists: 'present' },
            { requirement: 'entity-user', claim: 'User schema', basis: 'verified', exists: 'present' },
        ];

        const verdict = judgeSufficiency({ requirements, answers });

        assert.equal(verdict.level, 'sufficient');
        assert.equal(verdict.requirements.length, 2);

        // Every requirement maintains individual level and basis
        assert.equal(verdict.requirements[0].level, 'sufficient');
        assert.equal(verdict.requirements[0].basis, 'retrieved');
        assert.equal(verdict.requirements[0].source, 'bar');

        assert.equal(verdict.requirements[1].level, 'sufficient');
        assert.equal(verdict.requirements[1].basis, 'verified');
        assert.equal(verdict.requirements[1].source, 'work');
    });

    it('AC-SUF-01-02: Untraceable requirement is cannot-judge with reason in unknowns, unknown != absent', () => {
        const requirements = [
            { subject: 'unindexed-tool', asks: 'usage', min_basis: 'retrieved', source: 'declared' },
        ];

        // No answer provided (untraceable / unindexed)
        const verdict = judgeSufficiency({ requirements, answers: [] });

        assert.equal(verdict.level, 'cannot-judge');
        assert.equal(verdict.requirements[0].level, 'cannot-judge');
        assert.equal(verdict.requirements[0].exists, 'unknown');
        assert.notEqual(verdict.requirements[0].exists, 'absent', 'unknown != absent');

        assert.equal(verdict.unknowns.length, 1);
        assert.equal(verdict.unknowns[0].what, 'unindexed-tool');
        assert.match(verdict.unknowns[0].reason, /không tra được/);
    });

    it('AC-SUF-01-03: Gaps list is finite, countable, includes what + where_hint (defaulting to không rõ nguồn)', () => {
        const requirements = [
            { subject: 'missing-rule', asks: 'rule-text', min_basis: 'verified', source: 'declared', where_hint: 'docs/invariants.md' },
            { subject: 'unknown-origin', asks: 'contract', min_basis: 'verified', source: 'bar', where_hint: null },
        ];

        const answers = [
            { requirement: 'missing-rule', claim: null, basis: 'inferred', exists: 'absent' },
            { requirement: 'unknown-origin', claim: null, basis: 'inferred', exists: 'absent' },
        ];

        const verdict = judgeSufficiency({ requirements, answers });

        assert.equal(verdict.level, 'insufficient');
        assert.equal(verdict.gaps.length, 2);
        assert.equal(verdict.gaps[0].what, 'unknown-origin');
        assert.match(verdict.gaps[0].where_hint, /từ nguồn bar|không rõ nguồn/);

        assert.equal(verdict.gaps[1].what, 'missing-rule');
        assert.equal(verdict.gaps[1].where_hint, 'docs/invariants.md');
    });

    it('AC-SUF-01-04: Host lacking required capability yields cannot-judge + named capability, assurance DEGRADED', () => {
        const requirements = [
            { subject: 'ast-analysis', asks: 'codegraph ast query', min_basis: 'verified', source: 'work', required_capability: 'codegraph' },
        ];

        const verdict = judgeSufficiency({
            requirements,
            host: { missing_capabilities: ['codegraph'] },
        });

        assert.equal(verdict.level, 'cannot-judge');
        assert.equal(verdict.assurance, 'DEGRADED');
        assert.equal(verdict.unknowns.length, 1);
        assert.equal(verdict.unknowns[0].missing_capability, 'codegraph');
        assert.match(verdict.unknowns[0].reason, /host thiếu năng lực: codegraph/);
    });

    it('AC-SUF-01-05: Verdict does not automatically change mode; mode is selected and recorded separately', () => {
        const requirements = [
            { subject: 'missing-item', asks: 'doc', min_basis: 'verified', source: 'work' },
        ];

        const answers = [
            { requirement: 'missing-item', claim: null, basis: 'inferred', exists: 'absent' },
        ];

        // Operator explicitly chose mode 'ask'
        const verdict = judgeSufficiency({
            requirements,
            answers,
            mode: 'ask',
            mode_selected_by: 'operator-alice',
        });

        assert.equal(verdict.level, 'insufficient');
        assert.equal(verdict.mode, 'ask');
        assert.equal(verdict.mode_selected_by, 'operator-alice');
        assert.notEqual(verdict.mode, 'block', 'insufficient must not automatically force block');
    });

    it('AC-SUF-01-06 / ED4: basis == min_basis is satisfied (sufficient if no other requirement is unsat)', () => {
        const requirements = [
            { subject: 'exact-match', asks: 'signature', min_basis: 'retrieved', source: 'blast' },
        ];

        const answers = [
            { requirement: 'exact-match', claim: 'Signature exists', basis: 'retrieved', exists: 'present' },
        ];

        const verdict = judgeSufficiency({ requirements, answers });

        assert.equal(verdict.level, 'sufficient');
        assert.equal(verdict.basis, 'retrieved');
        assert.equal(verdict.sat.length, 1);
        assert.equal(verdict.unsat.length, 0);
    });

    it('AC-SUF-01-07 / ED1: Empty requirements list yields cannot-judge + không có gì để yêu cầu, never sufficient', () => {
        const verdict = judgeSufficiency({ requirements: [] });

        assert.equal(verdict.level, 'cannot-judge');
        assert.equal(verdict.basis, 'declared');
        assert.notEqual(verdict.level, 'sufficient');
        assert.equal(verdict.unknowns.length, 1);
        assert.equal(verdict.unknowns[0].reason, 'không có gì để yêu cầu');
    });

    it('AC-SUF-01-08 / BR-04: Rejects requirement missing source or invalid source with SOURCE_MISSING', () => {
        assert.throws(() => {
            deriveRequirements({
                work: [{ subject: 'bad-req', asks: 'no-source', min_basis: 'retrieved', source: null }],
            });
        }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));

        assert.throws(() => {
            deriveRequirements({
                bar: [{ subject: 'invented-req', asks: 'ai-guess', min_basis: 'retrieved', source: 'ai' }],
            });
        }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));

        assert.throws(() => {
            judgeSufficiency({
                requirements: [{ subject: 'missing-src', asks: 'check', min_basis: 'retrieved' }],
            });
        }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));
    });

    it('INV-ESO-02: cannot-judge never becomes permitted without explicit bypass', () => {
        const requirements = [
            { subject: 'unindexed', asks: 'info', min_basis: 'verified', source: 'declared' },
        ];

        const verdict = judgeSufficiency({
            requirements,
            answers: [], // yields cannot-judge
            mode: 'permitted',
        });

        assert.equal(verdict.level, 'cannot-judge');
        assert.equal(verdict.mode, 'ask', 'cannot-judge must be downgraded to ask when permitted is requested');
    });

    it('Section 6.2: Per-requirement min_basis prevents false all-or-nothing evaluation', () => {
        const requirements = [
            { subject: 'low-bar', asks: 'preview', min_basis: 'inferred', source: 'bar' },
            { subject: 'high-bar', asks: 'proof', min_basis: 'verified', source: 'work' },
        ];

        // Answer provides retrieved for both
        const answers = [
            { requirement: 'low-bar', claim: 'inferred ok', basis: 'retrieved', exists: 'present' },
            { requirement: 'high-bar', claim: 'retrieved only', basis: 'retrieved', exists: 'present' },
        ];

        const verdict = judgeSufficiency({ requirements, answers });

        assert.equal(verdict.level, 'partial');
        assert.equal(verdict.ratio, '1/2');
        assert.equal(verdict.sat.length, 1);
        assert.equal(verdict.unsat.length, 1);
        assert.equal(verdict.sat[0].subject, 'low-bar');
        assert.equal(verdict.unsat[0].subject, 'high-bar');
    });

    describe('US-SUF-02: Operator Sufficiency Explanation & Bypass (ESO-100 / Slice S1)', () => {
        it('AC-SUF-02-01: Explains to operator: việc gì, thiếu gì, cần cung cấp gì in plain language', () => {
            const requirements = [
                { subject: 'payment-webhook', asks: 'secret', min_basis: 'verified', source: 'bar', where_hint: 'Stripe dashboard' },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'payment-webhook', claim: null, basis: 'inferred', exists: 'absent' }],
            });

            const expl = formatOperatorExplanation(verdict, { task_description: 'Tích hợp cổng thanh toán Stripe' });

            assert.equal(expl.task, 'Tích hợp cổng thanh toán Stripe');
            assert.deepEqual(expl.summary.missing, ['payment-webhook']);
            assert(expl.summary.actions_needed[0].includes('payment-webhook'));
            assert(expl.summary.actions_needed[0].includes('Stripe dashboard'));
        });

        it('AC-SUF-02-02: Undeclared item explicitly states "cần bạn khai X", never assumes a default', () => {
            const requirements = [
                { subject: 'INV-TENANT-ISOLATION', asks: 'rule', min_basis: 'verified', source: 'declared' },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'INV-TENANT-ISOLATION', claim: null, basis: 'inferred', exists: 'absent' }],
            });

            const expl = formatOperatorExplanation(verdict);
            assert.deepEqual(expl.user_declarations_needed, ['INV-TENANT-ISOLATION']);
            assert(expl.summary.actions_needed.some((act) => act.includes('cần bạn khai INV-TENANT-ISOLATION')));
        });

        it('AC-SUF-02-03: cannot-judge yields "không phán được" + reason; strictly forbids score or percentage', () => {
            const verdict = judgeSufficiency({ requirements: [] });
            const expl = formatOperatorExplanation(verdict, { task_description: 'Nâng cấp microservice' });

            assert.equal(expl.level, 'cannot-judge');
            assert(expl.cannot_judge_notice.includes('không phán được'));
            assert(expl.cannot_judge_notice.includes('không có gì để yêu cầu'));

            // Strictly no score and no percentage
            assert.equal(expl.score, undefined);
            assert.equal(expl.percentage, undefined);
        });

        it('AC-SUF-02-04: Operator bypass does not alter verdict level, records operator + deadline', () => {
            const requirements = [
                { subject: 'db-replica', asks: 'address', min_basis: 'verified', source: 'blast' },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'db-replica', claim: null, basis: 'inferred', exists: 'absent' }],
            });

            assert.equal(verdict.level, 'insufficient');

            const bypassed = applyOperatorBypass(verdict, {
                by: 'operator-thang',
                reason: 'Deploying hotfix to test cluster',
                expires_at: '2026-11-04T04:00:00.000Z',
            });

            assert.equal(bypassed.level, 'insufficient', 'Verdict level must NEVER be raised to sufficient on bypass');
            assert.equal(bypassed.mode, 'bypassed');
            assert.equal(bypassed.mode_selected_by, 'operator-thang');
            assert.equal(bypassed.bypass.by, 'operator-thang');
            assert.equal(bypassed.bypass.expires_at, '2026-11-04T04:00:00.000Z');

            const expl = formatOperatorExplanation(bypassed, { bypass: bypassed.bypass });
            assert.equal(expl.level, 'insufficient');
            assert.equal(expl.mode, 'bypassed');
            assert.equal(expl.bypass.bypassed_by, 'operator-thang');
        });

        it('AC-SUF-02-05: Countable number of missing items (ratio |unsat|/|reqs|) and primary blocker', () => {
            const reqs = [];
            for (let i = 1; i <= 20; i++) {
                reqs.push({ subject: `req-${i}`, asks: 'contract', min_basis: 'verified', source: 'bar' });
            }
            // 5 satisfied, 15 unsat
            const answers = [];
            for (let i = 1; i <= 5; i++) {
                answers.push({ requirement: `req-${i}`, claim: 'ok', basis: 'verified', exists: 'present' });
            }

            const verdict = judgeSufficiency({ requirements: reqs, answers });
            assert.equal(verdict.level, 'partial');

            const expl = formatOperatorExplanation(verdict);
            assert.equal(expl.total_missing, 15);
            assert.equal(expl.total_requirements, 20);
            assert.equal(expl.ratio, '15/20');
            assert.equal(expl.primary_blocker, 'req-6');
            assert.equal(expl.gaps.length, 15);
        });

        it('AC-SUF-02-06: Deleted/gone source still listed with "nguồn đã mất", never omitted, never guessing', () => {
            const requirements = [
                { subject: 'orphan-rule', asks: 'spec', min_basis: 'verified', source: 'declared', source_gone: true },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'orphan-rule', claim: null, basis: 'inferred', exists: 'absent' }],
            });

            assert.equal(verdict.gaps.length, 1);
            assert.equal(verdict.gaps[0].what, 'orphan-rule');
            assert.equal(verdict.gaps[0].where_hint, 'nguồn đã mất');
            assert.equal(verdict.gaps[0].source_gone, true);

            const expl = formatOperatorExplanation(verdict);
            assert.equal(expl.gaps[0].where_hint, 'nguồn đã mất');
            assert(expl.summary.actions_needed[0].includes('nguồn đã mất cho orphan-rule'));
        });

        it('AC-SUF-02-07 / BR-01 / BR-09: Pure function without threshold dependencies yields identical level across runs', () => {
            const requirements = [
                { subject: 'static-req-1', asks: 'proof', min_basis: 'retrieved', source: 'bar' },
                { subject: 'static-req-2', asks: 'proof', min_basis: 'verified', source: 'work' },
            ];
            const answers = [
                { requirement: 'static-req-1', claim: 'ok', basis: 'retrieved', exists: 'present' },
                { requirement: 'static-req-2', claim: 'ok', basis: 'retrieved', exists: 'present' }, // unsat (verified > retrieved)
            ];

            const run1 = judgeSufficiency({ requirements, answers });
            const run2 = judgeSufficiency({ requirements, answers });

            assert.equal(run1.level, run2.level);
            assert.equal(run1.ratio, run2.ratio);
            assert.equal(run1.level, 'partial');
        });
    });

    describe('US-SUF-05: Gap Explanation & Reporter (ESO-105 / Slice S1)', () => {
        it('AC-SUF-05-01: Every gap item specifies a valid source in [bar, work, blast, declared]', () => {
            const requirements = [
                { subject: 'gap-bar', asks: 'check', min_basis: 'verified', source: 'bar' },
                { subject: 'gap-blast', asks: 'check', min_basis: 'verified', source: 'blast' },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [],
            });

            const report = formatGapReport(verdict);
            assert.equal(report.gap_items.length, 2);
            assert.equal(report.gap_items[0].source, 'bar');
            assert.equal(report.gap_items[1].source, 'blast');
        });

        it('AC-SUF-05-02: level < sufficient without gap details is rejected with NO_GAP_DETAIL', () => {
            // Fake an invalid verdict where level < sufficient but gaps is empty
            const invalidVerdict = {
                level: 'insufficient',
                gaps: [],
            };

            assert.throws(() => {
                formatGapReport(invalidVerdict);
            }, (err) => err.code === 'NO_GAP_DETAIL' || /NO_GAP_DETAIL/.test(err.message));
        });

        it('AC-SUF-05-03: Gap item with exists=unknown is displayed as unknown, NOT as missing/thiếu', () => {
            const requirements = [
                { subject: 'unreachable-rule', asks: 'spec', min_basis: 'verified', source: 'declared' },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'unreachable-rule', claim: null, basis: 'inferred', exists: 'unknown' }],
            });

            const report = formatGapReport(verdict);
            assert.equal(report.gap_items[0].status, 'unknown');
            assert.notEqual(report.gap_items[0].status, 'missing');
        });

        it('AC-SUF-05-04 & AC-SUF-05-05: Gaps ordered by (source_order, blocking_first, seq) deterministically for 50 items', () => {
            const requirements = [];
            const sources = ['declared', 'blast', 'work', 'bar']; // reverse natural order

            for (let i = 0; i < 50; i++) {
                requirements.push({
                    subject: `item-${i}`,
                    asks: 'rule',
                    min_basis: 'verified',
                    source: sources[i % 4],
                });
            }

            const answers = requirements.map((r, i) => ({
                requirement: r.subject,
                claim: null,
                basis: 'inferred',
                exists: i % 2 === 0 ? 'absent' : 'unknown', // alternate absent/unknown
            }));

            const verdict1 = judgeSufficiency({ requirements, answers });
            const verdict2 = judgeSufficiency({ requirements, answers });

            const report1 = formatGapReport(verdict1);
            const report2 = formatGapReport(verdict2);

            assert.equal(report1.gap_items.length, 50);
            assert.deepEqual(report1.gap_items, report2.gap_items, 'Ordering must be strictly reproducible');

            // Bar items must appear before work, before blast, before declared
            const barIndex = report1.gap_items.findIndex((g) => g.source === 'bar');
            const workIndex = report1.gap_items.findIndex((g) => g.source === 'work');
            const blastIndex = report1.gap_items.findIndex((g) => g.source === 'blast');
            const declaredIndex = report1.gap_items.findIndex((g) => g.source === 'declared');

            assert(barIndex < workIndex, 'bar < work');
            assert(workIndex < blastIndex, 'work < blast');
            assert(blastIndex < declaredIndex, 'blast < declared');

            // Within same source, absent (blocking) must appear before unknown
            const firstBar = report1.gap_items.find((g) => g.source === 'bar' && g.exists === 'absent');
            const firstBarUnknown = report1.gap_items.find((g) => g.source === 'bar' && g.exists === 'unknown');
            assert(report1.gap_items.indexOf(firstBar) < report1.gap_items.indexOf(firstBarUnknown));
        });

        it('AC-SUF-05-06 / ED10: Deleted source requirement is preserved with "nguồn đã mất" and dangling_source=true', () => {
            const requirements = [
                { subject: 'deleted-role-req', asks: 'rule', min_basis: 'verified', source: 'bar', source_gone: true },
            ];
            const verdict = judgeSufficiency({
                requirements,
                answers: [{ requirement: 'deleted-role-req', claim: null, basis: 'inferred', exists: 'absent' }],
            });

            const report = formatGapReport(verdict);
            assert.equal(report.gap_items.length, 1);
            assert.equal(report.gap_items[0].dangling_source, true);
            assert.equal(report.gap_items[0].where_hint, 'nguồn đã mất');
        });

        it('AC-SUF-05-07 & 4.3-T: Missing graph yields cannot-judge, never insufficient, with basis=declared', () => {
            // Case A: Missing graph (graph not built)
            const verdictA = judgeSufficiency({
                requirements: [],
                graph: { built: false, missing: true },
            });

            assert.equal(verdictA.level, 'cannot-judge');
            assert.equal(verdictA.basis, 'declared');
            assert.equal(verdictA.cannot_judge_reason, 'missing_graph');
            assert.notEqual(verdictA.level, 'insufficient', 'Missing graph must NEVER yield insufficient');

            // Case B: Graph present (0.97 completeness) with 2 absent requirements -> yields insufficient
            const verdictB = judgeSufficiency({
                requirements: [
                    { subject: 'req-b1', asks: 'spec', min_basis: 'verified', source: 'blast' },
                    { subject: 'req-b2', asks: 'spec', min_basis: 'verified', source: 'blast' },
                ],
                answers: [
                    { requirement: 'req-b1', claim: null, basis: 'inferred', exists: 'absent' },
                    { requirement: 'req-b2', claim: null, basis: 'inferred', exists: 'absent' },
                ],
                graph: { built: true, completeness: 0.97 },
            });

            assert.equal(verdictB.level, 'insufficient');
            assert.equal(verdictB.gaps.length, 2);
            assert.notEqual(verdictA.level, verdictB.level, 'Cases A and B must differ in level');
        });
    });

    describe('US-SUF-04: "Why" Verdict Explanation & Diagnosis (ESO-110 / Slice S1)', () => {
        it('AC-SUF-04-01: Returns four parts: unmet requirements, missing evidence, prior conclusion, and unknowns[]', () => {
            const turnRecord = {
                project: 'proj-why-1',
                turn_id: 'turn-why-101',
                at: '2026-11-04T02:00:00.000Z',
                level: 'insufficient',
                mode: 'ask',
                basis: 'retrieved',
                rule_version: '1.0.0',
                payload: {
                    requirements: [
                        { subject: 'sec-audit', asks: 'spec', min_basis: 'verified', source: 'bar' },
                    ],
                    answers: [
                        { requirement: 'sec-audit', claim: null, basis: 'inferred', exists: 'absent' },
                    ],
                    files_used: [{ path: 'src/main.ts' }],
                    unknowns: [],
                },
            };

            const diag = explainTurnVerdict({
                project: 'proj-why-1',
                turn_id: 'turn-why-101',
                turnRecord,
            });

            // 1. Unmet requirements with cites
            assert.equal(diag.unmet.length, 1);
            assert.equal(diag.unmet[0].subject, 'sec-audit');
            assert(diag.unmet[0].cites.length >= 1);
            assert.equal(diag.unmet[0].cites[0].kind, 'requirement');

            // 2. Missing evidence
            assert.equal(diag.missing_evidence.length, 1);
            assert.equal(diag.missing_evidence[0].requirement, 'sec-audit');
            assert(diag.missing_evidence[0].cites.length >= 1);

            // 3. Prior conclusion (read directly, unchanged)
            assert.equal(diag.prior_conclusion.level, 'insufficient');
            assert.equal(diag.prior_conclusion.mode, 'ask');
            assert.equal(diag.prior_conclusion.basis, 'retrieved');
            assert.equal(diag.prior_conclusion.at, '2026-11-04T02:00:00.000Z');

            // 4. Unknowns list
            assert(Array.isArray(diag.unknowns));
        });

        it('AC-SUF-04-02: Surfaces unknown items in unknowns[]', () => {
            const turnRecord = {
                project: 'proj-why-2',
                turn_id: 'turn-why-102',
                level: 'cannot-judge',
                mode: 'ask',
                basis: 'declared',
                rule_version: '1.0.0',
                payload: {
                    requirements: [{ subject: 'unindexed-item', asks: 'doc', min_basis: 'verified', source: 'blast' }],
                    answers: [{ requirement: 'unindexed-item', claim: null, basis: 'inferred', exists: 'unknown', reason: 'chưa index' }],
                    files_used: [{ path: 'src/doc.md' }],
                },
            };

            const diag = explainTurnVerdict({
                project: 'proj-why-2',
                turn_id: 'turn-why-102',
                turnRecord,
            });

            assert(diag.unknowns.length > 0);
            assert(diag.unknowns.some((u) => u.what === 'unindexed-item' && u.exists === 'unknown'));
        });

        it('AC-SUF-04-03: Missing record throws NO_RECORD ("không có bản ghi") and does not synthesize verdict', () => {
            assert.throws(() => {
                explainTurnVerdict({
                    project: 'proj-why-3',
                    turn_id: 'turn-non-existent',
                    turnRecord: null,
                });
            }, (err) => err.code === 'NO_RECORD' || /NO_RECORD/.test(err.message) || /không có bản ghi/.test(err.message));
        });

        it('AC-SUF-04-04 / ED1: Turn that read 0 files states "không có bằng chứng" + unknowns entry, never infers evidence', () => {
            const turnRecord = {
                project: 'proj-why-4',
                turn_id: 'turn-why-empty-files',
                level: 'cannot-judge',
                mode: 'ask',
                basis: 'declared',
                rule_version: '1.0.0',
                payload: {
                    requirements: [],
                    answers: [],
                    files_used: [], // 0 files read
                },
            };

            const diag = explainTurnVerdict({
                project: 'proj-why-4',
                turn_id: 'turn-why-empty-files',
                turnRecord,
            });

            assert.equal(diag.evidence_empty, true);
            assert.equal(diag.evidence_note, 'không có bằng chứng');
            assert(diag.unknowns.some((u) => u.what === 'evidence' && u.reason.includes('không có bằng chứng')));
        });

        it('AC-SUF-04-05 / ED10: Referencing deleted file notes file is gone ("nguồn đã mất") as unknown (NOT absent)', () => {
            const turnRecord = {
                project: 'proj-why-5',
                turn_id: 'turn-why-dangling',
                level: 'insufficient',
                mode: 'ask',
                basis: 'retrieved',
                rule_version: '1.0.0',
                payload: {
                    files_used: [{ path: 'src/old-removed.ts', gone: true, dangling: true }],
                },
            };

            const diag = explainTurnVerdict({
                project: 'proj-why-5',
                turn_id: 'turn-why-dangling',
                turnRecord,
            });

            const danglingEntry = diag.unknowns.find((u) => u.what === 'src/old-removed.ts');
            assert(danglingEntry, 'Deleted file must be present in unknowns[]');
            assert.equal(danglingEntry.exists, 'unknown', 'Must be flagged as unknown, NEVER absent');
            assert(danglingEntry.reason.includes('nguồn đã mất') || danglingEntry.reason.includes('file không còn'));
        });
    });

    describe('US-SUF-03: Proactive Warning (ESO-115 / Slice S1)', () => {
        it('AC-SUF-03-01: Proactive warning emitted with missing gaps when level < sufficient', () => {
            const verdict = {
                level: 'partial',
                mode: 'do',
                gaps: [
                    { what: 'unverified-schema', where_hint: 'src/db.ts', source: 'bar', exists: 'absent' },
                ],
            };

            const res = emitProactiveWarning({
                verdict,
                task_id: 'task-sync-db',
                project: 'proj-warn-1',
            });

            assert.equal(res.warned, true);
            assert.equal(res.level, 'partial');
            assert.equal(res.warnings.length, 1);
            assert.equal(res.warnings[0].requirement, 'unverified-schema');
            assert.equal(res.blocked, false);
            assert(res.message.includes('CẢNH BÁO TỰ PHÁT'));
        });

        it('AC-SUF-03-02 & AC-SUF-03-04: Warns once per (task, requirement); running second time does not duplicate (count = 1)', () => {
            const verdict = {
                level: 'insufficient',
                mode: 'ask',
                gaps: [
                    { what: 'req-once', where_hint: 'specs/ac.md', source: 'work', exists: 'absent' },
                ],
            };
            const historyState = new Set();

            const pass1 = emitProactiveWarning({
                verdict,
                task_id: 'task-dedup',
                project: 'proj-dedup',
                historyState,
            });

            const pass2 = emitProactiveWarning({
                verdict,
                task_id: 'task-dedup',
                project: 'proj-dedup',
                historyState,
            });

            assert.equal(pass1.warned, true);
            assert.equal(pass1.warnings.length, 1);

            // Pass 2 does not warn again
            assert.equal(pass2.warned, false);
            assert.equal(pass2.deduplicated, true);
            assert.equal(pass2.warnings.length, 0);
        });

        it('AC-SUF-03-03 / BR-07: Proactive warning never blocks execution; mode is preserved', () => {
            const verdict = {
                level: 'partial',
                mode: 'do', // mode is 'do'
                gaps: [{ what: 'non-blocking-gap', where_hint: 'hint', source: 'blast', exists: 'absent' }],
            };

            const res = emitProactiveWarning({
                verdict,
                task_id: 'task-running',
            });

            assert.equal(res.warned, true);
            assert.equal(res.blocked, false, 'Proactive warning must NEVER block task');
            assert.equal(res.mode, 'do', 'Mode must not be coerced to block');
        });

        it('AC-SUF-03-05 / ED1: 0 requirements below sufficient yields 0 warnings, no empty warning created', () => {
            const verdict = {
                level: 'sufficient',
                mode: 'do',
                gaps: [],
            };

            const res = emitProactiveWarning({
                verdict,
                task_id: 'task-green',
            });

            assert.equal(res.warned, false);
            assert.equal(res.warnings.length, 0);
            assert.equal(res.message, null);
        });

        it('AC-SUF-03-06: False-positive = 0: level === sufficient emits no warning even if called', () => {
            const verdict = {
                level: 'sufficient',
                mode: 'do',
                gaps: [],
            };

            const res = emitProactiveWarning({
                verdict,
                task_id: 'task-sufficient-fp',
            });

            assert.equal(res.warned, false);
            assert.equal(res.warnings.length, 0);
        });
    });

    describe('US-SUF-06 / ESO-120: cannot-judge Bypass Lifecycle (Slice S1)', () => {
        const cannotJudgeVerdict = {
            level: 'cannot-judge',
            mode: 'ask',
            reason: 'all_unknown',
            gaps: [{ requirement: 'cache-endpoint', basis: 'declared', exists: 'unknown' }],
        };

        it('AC-SUF-06-01: cannot-judge allows proceed when explicitly bypassed with owner and expiry', () => {
            const bypassed = applyOperatorBypass(cannotJudgeVerdict, {
                by: 'A-01',
                expires_at: '2026-11-10T00:00:00.000Z',
                reason: 'Awaiting network team policy update',
                now: '2026-11-04T00:00:00.000Z',
            });

            assert.equal(bypassed.mode, 'bypassed');
            assert.equal(bypassed.level, 'cannot-judge', 'Level remains cannot-judge (INV-ESO-02)');
            assert.equal(bypassed.mode_selected_by, 'A-01');
            assert.equal(bypassed.bypass.by, 'A-01');
            assert.equal(bypassed.bypass.expires_at, '2026-11-10T00:00:00.000Z');
            assert.equal(bypassed.bypass.reason, 'Awaiting network team policy update');
        });

        it('AC-SUF-06-02: missing or empty by is rejected with BYPASS_NO_OWNER', () => {
            assert.throws(() => {
                applyOperatorBypass(cannotJudgeVerdict, {
                    by: '',
                    expires_at: '2026-11-10T00:00:00.000Z',
                });
            }, (err) => {
                assert.equal(err.code, 'BYPASS_NO_OWNER');
                return true;
            });

            assert.throws(() => {
                applyOperatorBypass(cannotJudgeVerdict, {
                    expires_at: '2026-11-10T00:00:00.000Z',
                });
            }, (err) => {
                assert.equal(err.code, 'BYPASS_NO_OWNER');
                return true;
            });
        });

        it('AC-SUF-06-03: missing or empty expires_at is rejected with BYPASS_NO_EXPIRY', () => {
            assert.throws(() => {
                applyOperatorBypass(cannotJudgeVerdict, {
                    by: 'A-01',
                    expires_at: '',
                });
            }, (err) => {
                assert.equal(err.code, 'BYPASS_NO_EXPIRY');
                return true;
            });

            assert.throws(() => {
                applyOperatorBypass(cannotJudgeVerdict, {
                    by: 'A-01',
                });
            }, (err) => {
                assert.equal(err.code, 'BYPASS_NO_EXPIRY');
                return true;
            });
        });

        it('AC-SUF-06-04: past expiration deadline reverts to ask, never permitted', () => {
            const bypassed = applyOperatorBypass(cannotJudgeVerdict, {
                by: 'A-01',
                expires_at: '2026-11-04T00:00:00.000Z',
                now: '2026-11-03T00:00:00.000Z',
            });

            const effectiveMode = getEffectiveMode(bypassed, '2026-11-05T00:00:00.000Z');
            assert.equal(effectiveMode, 'ask', 'Must revert to ask');
            assert.notEqual(effectiveMode, 'permitted', 'Must never become permitted');

            const view = evaluateEffectiveVerdict(bypassed, '2026-11-05T00:00:00.000Z');
            assert.equal(view.mode, 'ask');
            assert.deepEqual(view.expired, {
                by: 'A-01',
                expires_at: '2026-11-04T00:00:00.000Z',
            });
        });

        it('AC-SUF-06-05 / ED8: exact clock match now == expires_at is considered expired immediately', () => {
            const expiry = '2026-11-04T12:00:00.000Z';
            const bypassed = applyOperatorBypass(cannotJudgeVerdict, {
                by: 'A-01',
                expires_at: expiry,
                now: '2026-11-04T10:00:00.000Z',
            });

            // At T-1: still active
            assert.equal(isBypassExpired(bypassed, '2026-11-04T11:59:59.999Z'), false);
            assert.equal(getEffectiveMode(bypassed, '2026-11-04T11:59:59.999Z'), 'bypassed');

            // At exact deadline T: EXPIRED
            assert.equal(isBypassExpired(bypassed, expiry), true);
            assert.equal(getEffectiveMode(bypassed, expiry), 'ask');

            // At T+1: EXPIRED
            assert.equal(isBypassExpired(bypassed, '2026-11-04T12:00:00.001Z'), true);
            assert.equal(getEffectiveMode(bypassed, '2026-11-04T12:00:00.001Z'), 'ask');
        });

        it('AC-SUF-06-06 / ED6: second bypass when first is active is rejected, keeps original by & expiry', () => {
            const initialBypass = applyOperatorBypass(cannotJudgeVerdict, {
                by: 'A-01',
                expires_at: '2026-11-05T00:00:00.000Z',
                reason: 'Initial override',
                now: '2026-11-04T00:00:00.000Z',
            });

            // Attempt second bypass while active at T+1hr
            assert.throws(() => {
                applyOperatorBypass(initialBypass, {
                    by: 'A-02',
                    expires_at: '2026-11-10T00:00:00.000Z',
                    reason: 'Attempted renewal/extension',
                    now: '2026-11-04T01:00:00.000Z',
                });
            }, (err) => {
                assert.equal(err.code, 'BYPASS_ALREADY_ACTIVE');
                return true;
            });

            // Original record is unaltered
            assert.equal(initialBypass.mode, 'bypassed');
            assert.equal(initialBypass.bypass.by, 'A-01');
            assert.equal(initialBypass.bypass.expires_at, '2026-11-05T00:00:00.000Z');
            assert.equal(initialBypass.bypass.reason, 'Initial override');
        });
    });
});
