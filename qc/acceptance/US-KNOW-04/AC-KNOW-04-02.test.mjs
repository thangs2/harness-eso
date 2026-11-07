import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-17 · AC-KNOW-04-02 — agent tự đẩy ⇒ không vào KB, nêu "chờ owner duyệt"', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof transferToKnowledgeBase,
        'function',
        'transferToKnowledgeBase phải được export từ eso/knowledge/src/index.mjs',
    );

    const project = {
        id: 'project-alpha',
        kindOwners: { decision: 'A-04', policy: 'A-08' },
        declarations: [],
        proposals: [],
    };
    const proposal = {
        id: 'PROP-04-02',
        kind: 'decision',
        title: 'Đổi sang message queue',
        content: 'Agent cho rằng đã rõ ràng đúng.',
        source: 'docs/decisions/d2.md',
        author: 'A-02',
    };
    const agent = {
        id: 'agent-07',
        role: 'agent',
        decision: 'approve',
        reason: 'rõ ràng đúng, không cần hỏi ai',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver: agent });

    // INV-KB-02: máy không tự duyệt, kể cả khi nó tự thấy "rõ ràng đúng".
    assert.notEqual(result.status, 'approved', 'agent không được tự duyệt');
    assert.equal(result.status, 'pending', 'đề xuất phải nằm chờ owner duyệt');
    assert.equal(result.code, 'SELF_APPROVAL', 'mã FRD cho người đề xuất là máy và cũng là người duyệt');
    assert.equal(result.kt_state, null, 'không có bản ghi tri thức nào được duyệt');
    assert.equal(result.declaration, null, 'không được có bản ghi KB nào');
    assert.equal(result.record, null, 'không được có dấu duyệt của máy');
    assert.match(String(result.message ?? ''), /chờ owner duyệt/i, 'phải nói rõ đang chờ owner duyệt');
    assert.equal(project.declarations.length, 0, 'KB không được đổi');
    assert.equal(project.proposals.length, 1, 'đề xuất vẫn phải nằm trong lịch sử');
    assert.equal(project.proposals[0].status, 'pending');

    // Mạo danh id của chủ loại cũng không biến máy thành người duyệt.
    const impersonating = await transferToKnowledgeBase({
        project,
        proposal,
        approver: { ...agent, id: 'A-04' },
    });

    assert.notEqual(impersonating.status, 'approved', 'id giống owner không làm agent thành owner');
    assert.equal(impersonating.code, 'SELF_APPROVAL');
    assert.equal(impersonating.kt_state, null);
    assert.match(String(impersonating.message ?? ''), /chờ owner duyệt/i);
    assert.equal(project.declarations.length, 0, 'KB vẫn không được đổi');
    assert.equal(project.proposals.length, 1, 'không tạo thêm đề xuất trùng');
});
