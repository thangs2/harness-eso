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
    // FRD-F21 §2: bước thiếu `kind`/`owner` KHÔNG hiển thị ⇒ không thành bước, mà vào `rejected[]`.
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

    assert.deepEqual(result.next, [], 'phát hiện không quy được người KHÔNG được thành bước');
    assert.ok(Array.isArray(result.rejected), 'phải có rejected[] để nêu lý do từ chối');
    assert.equal(result.rejected.length, 1, 'đúng một dòng từ chối cho một phát hiện không có chủ');

    const rejection = result.rejected[0];
    assert.equal(rejection.code, 'OWNER_UNASSIGNED', 'mã FRD cho kind không suy ra được owner');
    assert.match(
        String(rejection.reason ?? ''),
        /chưa xác định người/i,
        'lý do từ chối phải nói rõ "chưa xác định người"',
    );
    assert.equal(
        result.next.some((step) => step.owner === '' || !step.owner),
        false,
        'không được độn một bước với ô người trống',
    );
});
