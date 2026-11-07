import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { nextActions } = knowledge;

test('SCN-KNOW-12 · AC-KNOW-03-02 — không quy được người ⇒ nêu "chưa xác định người"', async () => {
    // RED: nextActions chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof nextActions,
        'function',
        'nextActions phải được export từ eso/knowledge/src/index.mjs',
    );

    // Phát hiện thuộc loại `decision` nhưng bảng kind→owner không có chủ — không được lấy vai mặc định.
    const findings = [
        {
            id: 'F-12-01',
            kind: 'decision',
            code: 'MISSING_KIND',
            reason: 'thiếu loại decision',
            consequence: 'tranh chấp không có điểm dừng',
        },
    ];
    const kindOwners = {};
    const playbooks = { decision: 'docs/templates/decision-playbook.md' };

    const result = await nextActions({ project: 'project-unowned', findings, kindOwners, playbooks });

    assert.equal(result.next.length, 1, 'việc vẫn phải có, nhưng ô người để trống');
    const [step] = result.next;

    assert.equal(step.finding, 'F-12-01', 'việc phải neo đúng phát hiện');
    assert.equal(step.kind, 'decision');
    assert.equal(step.owner, '', 'ô người phải để trống — không được gán bừa một vai mặc định');
    assert.doesNotMatch(String(step.owner), /^A-\d+$/, 'không được lấy vai mặc định của người viết story');
    assert.equal(step.code, 'OWNER_UNASSIGNED', 'mã FRD cho kind không suy ra được owner');

    assert.match(
        String(step.note ?? ''),
        /chưa xác định người/i,
        'ô người trống phải có nhãn nói rõ "chưa xác định người"',
    );
});
