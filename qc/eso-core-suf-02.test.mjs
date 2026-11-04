import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    judgeSufficiency,
    formatOperatorExplanation,
    applyOperatorBypass,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-08 (AC-SUF-02-01): Operator receives clear explanation: việc gì, thiếu gì, cần cung cấp gì in plain language', () => {
    const requirements = [
        { subject: 'sms-gateway', asks: 'api-key', min_basis: 'verified', source: 'bar', where_hint: 'Twilio Console' },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'sms-gateway', claim: null, basis: 'inferred', exists: 'absent' }],
    });

    const report = formatOperatorExplanation(verdict, {
        task_description: 'Cấu hình dịch vụ gửi mã OTP qua SMS',
    });

    assert.equal(report.task, 'Cấu hình dịch vụ gửi mã OTP qua SMS');
    assert.deepEqual(report.summary.missing, ['sms-gateway']);
    assert(report.summary.actions_needed[0].includes('sms-gateway'));
    assert(report.summary.actions_needed[0].includes('Twilio Console'));
});

test('SCN-SUF-09 (AC-SUF-02-02): Undeclared requirement states "cần bạn khai X", never assumes a default', () => {
    const requirements = [
        { subject: 'POLICY-DATA-RETENTION', asks: 'days', min_basis: 'verified', source: 'declared' },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'POLICY-DATA-RETENTION', claim: null, basis: 'inferred', exists: 'absent' }],
    });

    const report = formatOperatorExplanation(verdict);
    assert.deepEqual(report.user_declarations_needed, ['POLICY-DATA-RETENTION']);
    assert(report.summary.actions_needed.some((act) => act.includes('cần bạn khai POLICY-DATA-RETENTION')));
});

test('SCN-SUF-10 (AC-SUF-02-03): cannot-judge states "không phán được" + reason; strictly forbids scores or percentages', () => {
    const verdict = judgeSufficiency({ requirements: [] });
    const report = formatOperatorExplanation(verdict, { task_description: 'Triển khai cụm Redis mới' });

    assert.equal(report.level, 'cannot-judge');
    assert(report.cannot_judge_notice.includes('không phán được'));
    assert(report.cannot_judge_notice.includes('không có gì để yêu cầu'));

    // AC-SUF-02-03: Zero score, zero percentage in operator view
    assert.equal(report.score, undefined);
    assert.equal(report.percentage, undefined);
});

test('SCN-SUF-11 (AC-SUF-02-04): Operator bypass allows proceeding with operator + deadline, level is never elevated', () => {
    const requirements = [
        { subject: 'compliance-audit', asks: 'sign-off', min_basis: 'verified', source: 'bar' },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'compliance-audit', claim: null, basis: 'inferred', exists: 'absent' }],
    });

    assert.equal(verdict.level, 'insufficient');

    const bypassed = applyOperatorBypass(verdict, {
        by: 'sec-lead-bob',
        reason: 'Temporary approval for emergency hotfix',
        expires_at: '2026-11-04T12:00:00.000Z',
    });

    assert.equal(bypassed.level, 'insufficient', 'Bypass must never alter verdict level to sufficient');
    assert.equal(bypassed.mode, 'bypassed');
    assert.equal(bypassed.mode_selected_by, 'sec-lead-bob');
    assert.equal(bypassed.bypass.by, 'sec-lead-bob');
    assert.equal(bypassed.bypass.expires_at, '2026-11-04T12:00:00.000Z');

    const report = formatOperatorExplanation(bypassed, { bypass: bypassed.bypass });
    assert.equal(report.level, 'insufficient');
    assert.equal(report.mode, 'bypassed');
    assert.equal(report.bypass.bypassed_by, 'sec-lead-bob');
});

test('SCN-SUF-28 (AC-SUF-02-05 & ED3): Large requirement set yields countable missing items (|unsat|/|reqs|) and primary blocker', () => {
    const reqs = [];
    for (let i = 1; i <= 100; i++) {
        reqs.push({ subject: `large-req-${i}`, asks: 'rule', min_basis: 'verified', source: 'work' });
    }
    const answers = [];
    for (let i = 1; i <= 25; i++) {
        answers.push({ requirement: `large-req-${i}`, claim: 'verified', basis: 'verified', exists: 'present' });
    }

    const verdict = judgeSufficiency({ requirements: reqs, answers });
    assert.equal(verdict.level, 'partial');

    const report = formatOperatorExplanation(verdict);
    assert.equal(report.total_missing, 75);
    assert.equal(report.total_requirements, 100);
    assert.equal(report.ratio, '75/100');
    assert.equal(report.primary_blocker, 'large-req-26');
    assert.equal(report.gaps.length, 75);
});

test('SCN-SUF-29 (AC-SUF-02-06 & ED10): Deleted source is still stated with "nguồn đã mất", never dropped', () => {
    const requirements = [
        { subject: 'deprec-contract', asks: 'spec', min_basis: 'verified', source: 'blast', source_gone: true },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'deprec-contract', claim: null, basis: 'inferred', exists: 'absent' }],
    });

    assert.equal(verdict.gaps.length, 1);
    assert.equal(verdict.gaps[0].what, 'deprec-contract');
    assert.equal(verdict.gaps[0].where_hint, 'nguồn đã mất');

    const report = formatOperatorExplanation(verdict);
    assert.equal(report.gaps[0].where_hint, 'nguồn đã mất');
    assert(report.summary.actions_needed[0].includes('nguồn đã mất cho deprec-contract'));
});

test('SCN-SUF-39 (AC-SUF-02-07 & BR-01 & BR-09): Deterministic calculation without profile threshold dependencies', () => {
    const reqs = [
        { subject: 'req-a', asks: 'a', min_basis: 'retrieved', source: 'bar' },
        { subject: 'req-b', asks: 'b', min_basis: 'verified', source: 'bar' },
    ];
    const answers = [
        { requirement: 'req-a', claim: 'ok', basis: 'retrieved', exists: 'present' },
        { requirement: 'req-b', claim: 'ok', basis: 'retrieved', exists: 'present' },
    ];

    const v1 = judgeSufficiency({ requirements: reqs, answers });
    const v2 = judgeSufficiency({ requirements: reqs, answers });

    assert.equal(v1.level, v2.level);
    assert.equal(v1.ratio, v2.ratio);
    assert.equal(v1.level, 'partial');
});
