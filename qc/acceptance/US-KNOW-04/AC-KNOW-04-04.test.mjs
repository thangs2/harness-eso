import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-19 · AC-KNOW-04-04 — duyệt hai lần ⇒ replay, đúng một bản ghi', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof transferToKnowledgeBase,
        'function',
        'transferToKnowledgeBase phải được export từ eso/knowledge/src/index.mjs',
    );

    const project = {
        id: 'project-alpha',
        kindOwners: { decision: 'A-04' },
        declarations: [],
        proposals: [],
    };
    const proposal = {
        id: 'PROP-04-04',
        kind: 'decision',
        title: 'Chốt dùng Fastify',
        content: 'Cùng một đề xuất, duyệt hai lần.',
        source: 'docs/decisions/d4.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-04',
        role: 'owner',
        decision: 'approve',
        reason: 'đúng chủ loại, bằng chứng đã đủ',
    };

    const first = await transferToKnowledgeBase({ project, proposal, approver });
    const second = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(first.status, 'approved');
    assert.equal(first.kt_state, 'approved');
    assert.equal(second.status, 'replay', 'lần duyệt thứ hai là replay, không phải duyệt mới');
    assert.equal(second.kt_state, 'approved', 'replay vẫn trả về kt-state của bản ghi đã duyệt');
    assert.equal(project.declarations.length, 1, 'KB phải có đúng một bản, không ghi hai dòng');
    assert.equal(
        project.declarations.filter((row) => row.proposal_id === proposal.id).length,
        1,
        'chỉ một bản ghi duyệt cho một đề xuất',
    );

    assert.ok(second.declaration, 'replay phải trả lại bản ghi đã có');
    assert.equal(second.declaration.id, first.declaration.id, 'lần hai không được tạo bản mới');
    assert.equal(second.declaration.kt_state, 'approved');
    assert.equal(project.declarations[0].id, first.declaration.id);

    assert.deepEqual(second.record, first.record, 'replay phải giữ nguyên dấu duyệt gốc');
    assert.equal(project.declarations[0].record.at, first.record.at);
    assert.equal(project.proposals.length, 1, 'không tạo thêm đề xuất trùng');
    assert.equal(project.proposals[0].status, 'approved');
});
