import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-16 · AC-KNOW-04-01 — đề xuất hợp lệ được owner duyệt ⇒ vào KB, một dòng dấu duyệt', async () => {
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
        id: 'PROP-04-01',
        kind: 'decision',
        title: 'Dùng Fastify cho control plane',
        content: 'Chốt dùng Fastify vì đội đã vận hành được.',
        source: 'consumer: docs/decisions/d1.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-04',
        role: 'owner',
        decision: 'approve',
        reason: 'đúng chủ loại, bằng chứng đã đủ',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(result.status, 'approved', 'owner duyệt đề xuất hợp lệ thì phải vào KB');
    // FRD-F22 §1: bản ghi tri thức mang `kt-state` ∈ {approved, rejected}; `kt-state` viết snake_case trong code.
    assert.equal(result.kt_state, 'approved', 'kt-state của bản ghi phải là approved');
    assert.ok(result.declaration, 'duyệt xong phải có bản ghi declaration');
    assert.equal(result.declaration.kind, proposal.kind);
    assert.equal(result.declaration.title, proposal.title);
    assert.equal(result.declaration.project, project.id, 'bản ghi phải thuộc đúng project');
    assert.equal(result.declaration.proposal_id, proposal.id, 'bản ghi phải trỏ về đề xuất');
    assert.equal(result.declaration.kt_state, 'approved', 'bản ghi đã lưu cũng phải mang kt-state');
    assert.equal(result.declaration.status, 'current');

    assert.equal(project.declarations.length, 1, 'KB phải có đúng một bản mới');
    assert.equal(project.declarations[0].id, result.declaration.id);
    assert.equal(project.declarations[0].kt_state, 'approved');

    assert.ok(result.record, 'mọi ghi phải có dấu duyệt');
    assert.equal(result.record.actor, 'A-04', 'dấu duyệt phải ghi ai');
    assert.equal(result.record.reason, approver.reason, 'dấu duyệt phải ghi vì sao');
    const decidedAt = Date.parse(result.record.at);
    assert.ok(Number.isFinite(decidedAt), 'dấu duyệt phải ghi khi nào, đọc lại được');
    const ageMs = Date.now() - decidedAt;
    assert.ok(ageMs >= 0 && ageMs < 60_000, 'thời điểm duyệt phải là lúc chạy, không phải mốc bịa');

    assert.ok(project.declarations[0].record, 'dấu duyệt phải nằm trong bản ghi đã lưu, đọc lại được');
    assert.equal(project.declarations[0].record.actor, 'A-04');
    assert.equal(project.declarations[0].record.at, result.record.at);

    assert.equal(project.proposals.length, 1, 'đề xuất đã duyệt vẫn còn trong lịch sử');
    assert.equal(project.proposals[0].status, 'approved');
});

test('SCN-KNOW-16 · AC-KNOW-04-01 — chủ khác duyệt ⇒ FOREIGN_APPROVER, KB không đổi', async () => {
    const project = {
        id: 'project-alpha',
        kindOwners: { decision: 'A-04', policy: 'A-08' },
        declarations: [],
        proposals: [],
    };
    const proposal = {
        id: 'PROP-04-01-FAIL',
        kind: 'decision',
        title: 'Dùng Fastify cho control plane',
        content: 'Chốt dùng Fastify vì đội đã vận hành được.',
        source: 'consumer: docs/decisions/d1.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-05',
        role: 'owner',
        decision: 'approve',
        reason: 'tôi duyệt thay chủ loại',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(result.status, 'blocked', 'chủ khác duyệt phải bị blocked');
    assert.equal(result.code, 'FOREIGN_APPROVER', 'mã lỗi FRD cho người duyệt không phải chủ kind');
    assert.equal(result.declaration, null);
    assert.equal(result.record, null);
    assert.equal(project.declarations.length, 0, 'KB không đổi');
});
