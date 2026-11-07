import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-18 · AC-KNOW-04-03 — owner từ chối ⇒ ghi lý do, không vào KB, giữ lịch sử', async () => {
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
        id: 'PROP-04-03',
        kind: 'decision',
        title: 'Bỏ kiểm thử tích hợp',
        content: 'Đề xuất giảm thời gian CI.',
        source: 'consumer: docs/decisions/d3.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-04',
        role: 'owner',
        decision: 'reject',
        reason: 'không đủ bằng chứng, không được bỏ kiểm thử',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(result.status, 'rejected', 'owner từ chối thì đề xuất không được vào KB');
    // FRD-F22 §1: quyết định từ chối cũng là một `kt-state`; không có bản ghi tri thức.
    assert.equal(result.kt_state, 'rejected', 'kt-state của quyết định phải là rejected');
    assert.equal(result.declaration, null, 'từ chối không được tạo bản ghi KB');
    assert.equal(project.declarations.length, 0, 'KB không được đổi');

    assert.ok(result.record, 'lý do từ chối phải được ghi');
    assert.equal(result.record.actor, 'A-04');
    assert.equal(result.record.reason, approver.reason);
    assert.ok(Number.isFinite(Date.parse(result.record.at)), 'dấu từ chối phải ghi khi nào');

    assert.equal(project.proposals.length, 1, 'không được xoá đề xuất khỏi lịch sử');
    assert.equal(project.proposals[0].id, proposal.id);
    assert.equal(project.proposals[0].status, 'rejected');
    assert.ok(project.proposals[0].record, 'dấu từ chối phải đọc lại được từ lịch sử');
    assert.equal(project.proposals[0].record.reason, approver.reason);
    assert.equal(project.proposals[0].record.at, result.record.at);
});
