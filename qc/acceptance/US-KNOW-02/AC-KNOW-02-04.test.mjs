import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { sufficiencyReport } = knowledge;

const TWELVE_KINDS = [
    'decision',
    'policy',
    'runbook',
    'skill',
    'rule',
    'agent',
    'adr',
    'spec',
    'guide',
    'checklist',
    'glossary',
    'contract',
];

test('SCN-KNOW-09 · AC-KNOW-02-04 — 12 loại đều thiếu ⇒ liệt kê từng loại + hậu quả', async () => {
    // RED: sufficiencyReport chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof sufficiencyReport,
        'function',
        'sufficiencyReport phải được export từ eso/knowledge/src/index.mjs',
    );

    const template = {
        kinds: TWELVE_KINDS.map((kind) => ({
            kind,
            consequence: `hậu quả khi thiếu ${kind}`,
        })),
    };

    // ED3: 12 loại đều thiếu — không có declaration nào.
    const report = await sufficiencyReport({
        project: 'project-alpha',
        template,
        declarations: [],
    });

    assert.equal(report.status, 'measured');
    assert.equal(report.findings.length, 12, 'số finding phải khớp số loại thiếu');
    assert.deepEqual(
        report.findings.map((finding) => finding.kind).sort(),
        [...TWELVE_KINDS].sort(),
        'từng loại phải có finding riêng, không gộp',
    );
    for (const finding of report.findings) {
        assert.equal(finding.code, 'MISSING_KIND', `mỗi loại thiếu là MISSING_KIND (${finding.kind})`);
        assert.equal(
            finding.consequence,
            `hậu quả khi thiếu ${finding.kind}`,
            `mỗi loại phải nêu hậu quả riêng của nó (${finding.kind})`,
        );
        assert.equal(typeof finding.reason, 'string', `finding ${finding.kind} phải có lý do`);
        assert.ok(finding.reason.trim().length > 0, `lý do của ${finding.kind} không được rỗng`);
    }
    assert.doesNotMatch(
        report.message,
        /thiếu nhiều loại/i,
        'không được gộp thành "thiếu nhiều loại"',
    );
});
