import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { sufficiencyReport } = knowledge;

test('SCN-KNOW-06 · AC-KNOW-02-01 — thiếu hẳn loại decision ⇒ nêu kind + hậu quả', async () => {
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
            { kind: 'runbook', consequence: 'sự cố không có bước xử lý' },
        ],
    };
    const kindOwners = { decision: 'A-04', policy: 'A-08', runbook: 'A-09' };
    const project = { id: 'project-alpha', kindOwners };
    const declarations = [
        { kind: 'policy', id: 'policy-security', path: 'consumer: docs/policies/security.md', content: '# Security policy\n' },
        { kind: 'runbook', id: 'runbook-incident', path: 'docs/runbooks/incident.md', content: '# Incident runbook\n' },
    ];

    const report = await sufficiencyReport({
        project,
        template,
        declarations,
    });

    // FRD-F20 §1: `findings[]`, mỗi cái có `code` · `kind` · lý do (`reason`) · hậu quả (`consequence`) · `owner`.
    assert.equal(report.status, 'measured');
    assert.ok(Array.isArray(report.findings), 'kết quả phải có findings[] — không tách missing/duplicates/incorrect');
    assert.equal(report.findings.length, 1, 'chỉ decision thiếu so với template');
    assert.equal(report.findings[0].code, 'MISSING_KIND', 'mã FRD cho kind bắt buộc không có instance');
    assert.equal(report.findings[0].kind, 'decision');
    assert.equal(typeof report.findings[0].reason, 'string', 'mỗi finding phải nêu lý do');
    assert.ok(report.findings[0].reason.trim().length > 0, 'lý do không được rỗng');
    assert.equal(
        report.findings[0].consequence,
        'tranh chấp không có điểm dừng',
        'hậu quả phải lấy từ template của dự án',
    );
    // `INV-KB-01`: mục thiếu phải nêu người chịu, để còn biết hỏi ai. `owner` suy từ `kindOwners`.
    assert.equal(
        report.findings[0].owner,
        'A-04',
        'owner của finding phải suy từ kindOwners theo kind, không đọc từ tài liệu',
    );
    assert.equal(typeof report.findings[0].owner, 'string', 'owner phải là chuỗi');
    assert.ok(report.findings[0].owner.trim().length > 0, 'owner phải khác rỗng khi suy được từ kindOwners');
    assert.equal(typeof report.message, 'string');
    assert.match(report.message, /decision/, 'message phải nêu tên kind thiếu');
    assert.match(
        report.message,
        /tranh chấp không có điểm dừng/,
        'message phải nêu hậu quả, không chỉ nói thiếu tài liệu',
    );
    assert.doesNotMatch(report.message, /còn thiếu tài liệu/i);
});
