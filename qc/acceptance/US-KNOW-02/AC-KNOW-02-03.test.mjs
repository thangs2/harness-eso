import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { sufficiencyReport } = knowledge;

test('SCN-KNOW-08 · AC-KNOW-02-03 — hai bản gần giống ⇒ nêu trùng, không phải thiếu', async () => {
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
    const declarations = [
        { kind: 'decision', id: 'decision-postgres', path: 'consumer: docs/decisions/d1.md', content: '# Chốt Postgres\n' },
        { kind: 'runbook', id: 'runbook-incident', path: 'docs/runbooks/incident.md', content: '# Incident runbook\n' },
        {
            kind: 'policy',
            id: 'policy-security',
            path: 'consumer: docs/policies/security.md',
            content: '# Policy\nUse Postgres for all stores.\n',
        },
        {
            kind: 'policy',
            id: 'policy-security',
            path: 'consumer: docs/policies/security-copy.md',
            content: '# Policy\nUse Postgres for all stores.  \n',
        },
    ];

    const report = await sufficiencyReport({
        project: 'project-alpha',
        template,
        declarations,
    });

    // FRD-F20 §4: `DUPLICATE_ID` — cùng một `id` định nghĩa ở hai chỗ; một finding, không phải một mảng riêng.
    assert.equal(report.status, 'measured');
    assert.equal(report.findings.length, 1, 'policy có hai bản gần giống ⇒ đúng một finding trùng');
    assert.equal(report.findings[0].code, 'DUPLICATE_ID');
    assert.equal(report.findings[0].kind, 'policy');
    assert.equal(typeof report.findings[0].reason, 'string', 'finding trùng phải nêu lý do');
    assert.ok(report.findings[0].reason.trim().length > 0);
    assert.equal(report.findings[0].copies.length, 2, 'cả hai bản phải được nêu tên');
    assert.deepEqual(
        [...report.findings[0].copies].sort(),
        ['consumer: docs/policies/security-copy.md', 'consumer: docs/policies/security.md'],
        'không được đếm hai bản thành một',
    );
    assert.equal(
        report.findings.some((finding) => finding.code === 'MISSING_KIND' && finding.kind === 'policy'),
        false,
        'trùng không phải thiếu',
    );
    assert.match(report.message, /trùng/i, 'message phải nói là trùng, không phải thiếu');
    assert.match(report.message, /policy/);
});
