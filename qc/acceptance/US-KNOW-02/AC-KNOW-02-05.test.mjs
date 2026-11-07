import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { sufficiencyReport } = knowledge;

test('SCN-KNOW-10 · AC-KNOW-02-05 — loại có nhưng nội dung sai ⇒ tách sai khỏi thiếu', async () => {
    // RED: sufficiencyReport chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof sufficiencyReport,
        'function',
        'sufficiencyReport phải được export từ eso/knowledge/src/index.mjs',
    );

    const template = {
        kinds: [
            { kind: 'decision', consequence: 'tranh chấp không có điểm dừng' },
            { kind: 'policy', consequence: 'mỗi người làm một kiểu' },
        ],
    };
    const declarations = [
        { kind: 'decision', id: 'decision-postgres', path: 'docs/decisions/d1.md', content: '# Chốt Postgres\n' },
        // policy CÓ mặt nhưng là bản dẫn xuất nêu khẳng định từ một nguồn không có ⇒ "có nhưng sai".
        {
            kind: 'policy',
            id: 'policy-security',
            path: 'docs/policies/security.md',
            content: '# Policy\nDẫn xuất từ docs/policies/source.md\n',
            derivedFrom: 'docs/policies/source.md',
        },
    ];

    const report = await sufficiencyReport({
        project: 'project-alpha',
        template,
        declarations,
    });

    // FRD-F20 §4: `DERIVED_WITHOUT_SOURCE` — bản dẫn xuất nêu nguồn không có (`BR-16`).
    assert.equal(report.status, 'measured');
    assert.equal(report.findings.length, 1, 'policy có mặt nhưng sai ⇒ đúng một finding sai');
    assert.equal(report.findings[0].code, 'DERIVED_WITHOUT_SOURCE');
    assert.equal(report.findings[0].kind, 'policy');
    assert.equal(typeof report.findings[0].reason, 'string');
    assert.ok(report.findings[0].reason.length > 0, 'finding sai phải nêu lý do');
    assert.match(String(report.findings[0].reason), /nguồn/i, 'lý do phải nêu nguồn không có');
    assert.equal(
        report.findings.some((finding) => finding.code === 'MISSING_KIND'),
        false,
        'sai không được gộp vào thiếu — không có MISSING_KIND',
    );
    assert.equal(
        report.findings.some((finding) => finding.code === 'MISSING_KIND' && finding.kind === 'policy'),
        false,
    );
    assert.match(report.message, /policy/);
    assert.match(report.message, /nguồn/i, 'message phải phân biệt sai với thiếu');
});
