import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { nextActions } = knowledge;

test('SCN-KNOW-13 · AC-KNOW-03-03 — 20 phát hiện ⇒ next ≤ 5 bước, kèm TRUNCATED nói còn lại', async () => {
    // RED: nextActions chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof nextActions,
        'function',
        'nextActions phải được export từ eso/knowledge/src/index.mjs',
    );

    // ED3 — 20 phát hiện cùng lúc, mỗi cái có chủ riêng.
    const findings = Array.from({ length: 20 }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        const kind = i % 2 === 0 ? 'decision' : 'policy';
        return {
            id: `F-13-${n}`,
            kind,
            code: 'MISSING_KIND',
            reason: `thiếu loại ${kind} ở nhóm ${n}`,
            consequence: `hậu quả khi thiếu ${kind} ở nhóm ${n}`,
        };
    });
    const kindOwners = { decision: 'A-04', policy: 'A-08' };
    const playbooks = {
        decision: 'docs/templates/decision-playbook.md',
        policy: 'docs/templates/policy-playbook.md',
    };

    const result = await nextActions({ project: 'project-many', findings, kindOwners, playbooks });

    // FRD-F21 §2: mặc định `next` ≤ 5 bước; danh sách dài không được đọc.
    assert.ok(result.next.length > 0, 'phải có ít nhất một bước để làm');
    assert.ok(result.next.length <= 5, `next phải ≤ 5 bước, nhận ${result.next.length}`);

    // 1:1 — mỗi bước neo đúng một phát hiện, không gộp nhiều phát hiện vào một bước.
    assert.equal(
        new Set(result.next.map((step) => step.finding)).size,
        result.next.length,
        'mỗi bước phải neo vào một phát hiện riêng',
    );

    for (const step of result.next) {
        const finding = findings.find((row) => row.id === step.finding);
        assert.ok(finding, `bước ${step.finding} phải neo vào phát hiện có thật`);
        assert.equal(step.kind, finding.kind, `kind của ${step.finding} phải khớp phát hiện`);
        for (const part of ['action', 'owner', 'whyNow', 'blocker', 'playbook']) {
            assert.equal(typeof step[part], 'string', `phần ${part} của ${step.finding} phải là chữ`);
            assert.ok(step[part].trim().length > 0, `phần ${part} của ${step.finding} không được rỗng`);
        }
    }

    assert.equal(
        new Set(result.next.map((step) => step.action)).size,
        result.next.length,
        'mỗi bước phải là một câu riêng — không được gộp chung một câu',
    );

    // FRD-F21 §4: `TRUNCATED` — không phải lỗi, nhưng phải nói còn bao nhiêu.
    assert.equal(result.truncated?.code, 'TRUNCATED', 'cắt bước phải kèm mã TRUNCATED');
    assert.equal(
        result.truncated?.omitted,
        findings.length - result.next.length,
        'TRUNCATED phải nói đúng số phát hiện còn lại chưa thành bước',
    );
});
