import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { nextActions } = knowledge;

test('SCN-KNOW-14 · AC-KNOW-03-04 — nguồn đã mất ⇒ vẫn nêu phát hiện, ghi "nguồn đã mất"', async () => {
    // RED: nextActions chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof nextActions,
        'function',
        'nextActions phải được export từ eso/knowledge/src/index.mjs',
    );

    // ED10 — phát hiện trỏ tới một tài liệu đã bị xoá khỏi cây tài liệu.
    const missingSource = 'consumer: docs/decisions/removed-decision.md';
    const findings = [
        {
            id: 'F-14-01',
            kind: 'decision',
            code: 'MISSING_KIND',
            reason: 'thiếu loại decision',
            consequence: 'tranh chấp không có điểm dừng',
            source: missingSource,
            sourceExists: false,
        },
    ];
    const kindOwners = { decision: 'A-04' };
    const project = { id: 'project-lost-source', kindOwners };
    const playbooks = { decision: 'docs/templates/decision-playbook.md' };

    const result = await nextActions({ project, findings, playbooks });

    assert.equal(result.next.length, 1, 'mục không được biến mất chỉ vì nguồn đã mất');

    const [step] = result.next;
    assert.equal(step.finding, 'F-14-01', 'việc phải neo đúng phát hiện');
    assert.ok(String(step.action ?? '').trim().length > 0, 'việc vẫn phải nói làm gì');

    assert.match(String(step.note ?? ''), /nguồn đã mất/i, 'phải ghi rõ "nguồn đã mất"');
    assert.equal(
        step.source,
        missingSource,
        'giữ nguyên đường dẫn đã mất — không được đoán một nguồn khác',
    );
});
