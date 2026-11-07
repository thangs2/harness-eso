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
    const kindOwners = { decision: 'A-04', policy: 'A-08' };
    const project = { id: 'project-alpha', kindOwners };
    const declarations = [
        { kind: 'decision', id: 'decision-postgres', path: 'consumer: docs/decisions/d1.md', content: '# Chốt Postgres\n' },
        // policy CÓ mặt; nguồn của nó tồn tại và nói Postgres, nhưng bản policy nói MySQL ⇒ "có nhưng mâu thuẫn nguồn".
        {
            kind: 'policy',
            id: 'policy-source',
            path: 'consumer: docs/policies/source.md',
            content: '# Source\nUse Postgres for all stores.\n',
        },
        {
            kind: 'policy',
            id: 'policy-security',
            path: 'consumer: docs/policies/security.md',
            content: '# Policy\nUse MySQL for all stores.\n',
            derivedFrom: 'consumer: docs/policies/source.md',
        },
    ];

    const report = await sufficiencyReport({
        project,
        template,
        declarations,
    });

    // FRD-F20 §4: `CONTENT_CONTRADICTS` — nội dung có nhưng mâu thuẫn nguồn/khẳng định khác.
    // Khác `DERIVED_WITHOUT_SOURCE` (thiếu nguồn): ở đây nguồn có và còn nói ngược lại.
    assert.equal(report.status, 'measured');
    assert.equal(report.findings.length, 1, 'policy có mặt nhưng mâu thuẫn nguồn ⇒ đúng một finding sai');
    assert.equal(report.findings[0].code, 'CONTENT_CONTRADICTS');
    assert.equal(report.findings[0].kind, 'policy');
    assert.equal(typeof report.findings[0].reason, 'string');
    assert.ok(report.findings[0].reason.length > 0, 'finding sai phải nêu lý do');
    assert.match(String(report.findings[0].reason), /mâu thuẫn/i, 'lý do phải nêu mâu thuẫn, không phải thiếu nguồn');
    assert.equal(
        report.findings[0].consequence,
        'mỗi người làm một kiểu',
        'finding sai vẫn phải nêu hậu quả lấy từ template (FRD-F20 §2)',
    );
    assert.equal(
        report.findings.some((finding) => finding.code === 'MISSING_KIND'),
        false,
        'sai không được gộp vào thiếu — không có MISSING_KIND',
    );
    assert.equal(
        report.findings.some((finding) => finding.code === 'MISSING_KIND' && finding.kind === 'policy'),
        false,
    );
    assert.equal(
        report.findings.some((finding) => finding.code === 'DERIVED_WITHOUT_SOURCE'),
        false,
        'nguồn có mặt ⇒ không phải `DERIVED_WITHOUT_SOURCE`; mã đúng là `CONTENT_CONTRADICTS`',
    );
    assert.match(report.message, /policy/);
    assert.match(report.message, /mâu thuẫn/i, 'message phải phân biệt sai (mâu thuẫn) với thiếu');
});
