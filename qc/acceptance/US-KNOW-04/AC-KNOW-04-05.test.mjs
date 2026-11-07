import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { transferToKnowledgeBase } = knowledge;

test('SCN-KNOW-20 · AC-KNOW-04-05 — tên loại unicode dài ⇒ lưu và đọc lại nguyên vẹn', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof transferToKnowledgeBase,
        'function',
        'transferToKnowledgeBase phải được export từ eso/knowledge/src/index.mjs',
    );

    // ED9 — tên dài, có unicode, có cả dấu tiếng Việt tổ hợp; không được cắt, không được normalize ngầm.
    const kind =
        'quyết-định-kiến-trúc-và-chính-sách-vận-hành-hệ-thống-tri-thức-doanh-nghiệp-' +
        'phiên-bản-dài-nhất-cho-phép-e\u0302\u0323-tiếng-việt';
    assert.ok(kind.length >= 100, 'fixture phải là tên dài');
    assert.match(kind, /[^\x00-\x7F]/, 'fixture phải có unicode');

    const project = {
        id: 'project-unicode',
        kindOwners: { [kind]: 'A-04' },
        declarations: [],
        proposals: [],
    };
    const proposal = {
        id: 'PROP-04-05',
        kind,
        title: 'Tên loại dài có unicode',
        content: 'Kiểm tra lưu và đọc lại nguyên vẹn.',
        source: 'docs/decisions/d5.md',
        author: 'A-02',
    };
    const approver = {
        id: 'A-04',
        role: 'owner',
        decision: 'approve',
        reason: 'đúng chủ loại, tên hợp lệ',
    };

    const result = await transferToKnowledgeBase({ project, proposal, approver });

    assert.equal(result.status, 'approved');
    assert.equal(result.kt_state, 'approved');
    assert.ok(result.declaration);
    assert.equal(result.declaration.kind, kind, 'tên loại phải được lưu nguyên văn, không cắt');
    assert.equal(result.declaration.kt_state, 'approved');
    assert.equal(project.declarations.length, 1);
    assert.equal(project.declarations[0].kind, kind, 'đọc lại từ KB phải nguyên vẹn');
    assert.equal(project.declarations[0].kt_state, 'approved');
    assert.equal([...project.declarations[0].kind].length, [...kind].length, 'số điểm mã phải giữ nguyên');
    assert.equal(project.declarations[0].kind.normalize('NFC'), kind.normalize('NFC'));
    assert.equal(project.declarations[0].kind.normalize('NFD'), kind.normalize('NFD'));
});
