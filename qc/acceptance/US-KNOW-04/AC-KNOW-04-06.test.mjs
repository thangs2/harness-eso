import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-21 · AC-KNOW-04-06 — loại chưa có chủ ⇒ dừng, nêu "loại X chưa có chủ"', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof transferToKnowledgeBase,
        'function',
        'transferToKnowledgeBase phải được export từ eso/knowledge/src/index.mjs',
    );

    const project = {
        id: 'project-alpha',
        kindOwners: { decision: 'A-04', policy: '' },
        declarations: [],
        proposals: [],
    };
    const proposal = {
        id: 'PROP-04-06',
        kind: 'policy',
        title: 'Chính sách lưu log 90 ngày',
        content: 'Loại policy chưa có chủ trong project.',
        source: 'docs/policies/security.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-04',
        role: 'owner',
        decision: 'approve',
        reason: 'tôi duyệt',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(result.status, 'blocked', 'loại chưa có chủ thì phải dừng');
    assert.equal(result.code, 'OWNER_UNASSIGNED', 'mã FRD cho kind không suy ra được owner');
    assert.equal(result.kt_state, null, 'không có bản ghi tri thức nào được duyệt');
    assert.match(String(result.message ?? ''), /loại policy chưa có chủ/i, 'phải nêu đúng loại thiếu chủ');
    assert.equal(result.declaration, null, 'không được vào KB');
    assert.equal(result.record, null, 'không được ghi dấu duyệt');
    assert.equal(project.declarations.length, 0, 'KB không được đổi');

    assert.equal(project.proposals.length, 1, 'đề xuất vẫn chờ, chưa vào KB');
    assert.equal(project.proposals[0].id, proposal.id);
    assert.equal(project.proposals[0].status, 'pending');
    assert.ok(!project.proposals[0].record, 'chưa có chủ thì không có dấu duyệt');
    assert.ok(
        !project.proposals[0].owner,
        'không được gán bừa owner mặc định',
    );
});
