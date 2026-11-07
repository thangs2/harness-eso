import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { sufficiencyReport } = knowledge;

test('SCN-KNOW-07 · AC-KNOW-02-02 — chưa khai template ⇒ nói "chưa có template để đo", không đoán', async () => {
    // RED: sufficiencyReport chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof sufficiencyReport,
        'function',
        'sufficiencyReport phải được export từ eso/knowledge/src/index.mjs',
    );

    // project-beta chưa khai template. Declaration dưới đây thuộc project-alpha —
    // nếu report lấy template/declaration của project khác thì test này phải đỏ.
    const declarationsOfAnotherProject = [
        { kind: 'decision', id: 'decision-postgres', path: 'docs/decisions/d1.md', content: '# Chốt Postgres\n' },
    ];

    const report = await sufficiencyReport({
        project: 'project-beta',
        template: undefined,
        declarations: declarationsOfAnotherProject,
    });

    // FRD-F20 §3 + §4: chưa có template ⇒ từ chối đo, `NOT_MEASURED`, không phải "sạch".
    assert.equal(report.status, 'blocked');
    assert.equal(report.code, 'NOT_MEASURED', 'mã FRD cho chưa đo được');
    assert.deepEqual(report.findings, [], 'chưa có template thì không được kết luận thiếu/sai/trùng');
    assert.match(
        report.message,
        /chưa có template để đo/,
        'message phải nói rõ chưa có template, không đoán theo mặc định',
    );
});
