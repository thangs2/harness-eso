import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { nextActions } = knowledge;

test('SCN-KNOW-11 · AC-KNOW-03-01 — phát hiện "thiếu loại decision" ⇒ việc đủ bốn phần', async () => {
    // RED: nextActions chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof nextActions,
        'function',
        'nextActions phải được export từ eso/knowledge/src/index.mjs',
    );

    // Đầu vào là `findings[]` của F-20 (`code` · `kind` · `reason` · `consequence`), cộng bảng kind→owner
    // và playbook của kind — đúng FRD-F21 §1.
    const findings = [
        {
            id: 'F-11-01',
            kind: 'decision',
            code: 'MISSING_KIND',
            reason: 'thiếu loại decision',
            consequence: 'tranh chấp không có điểm dừng',
        },
    ];
    const kindOwners = { decision: 'A-04' };
    const playbooks = { decision: 'docs/templates/decision-playbook.md' };

    const result = await nextActions({ project: 'project-alpha', findings, kindOwners, playbooks });

    // FRD-F21 §1: đầu ra là `next[]`; mỗi bước: làm gì (`kind`) · ai (`owner`) · vì sao bây giờ · cái chặn · mẫu.
    assert.equal(result.total, 1, 'mỗi phát hiện đúng một việc');
    assert.ok(Array.isArray(result.next), 'kết quả phải có next[] — không dùng actions[]');
    assert.equal(result.next.length, 1, 'một phát hiện không được nở thành nhiều việc');

    const [step] = result.next;
    assert.equal(step.finding, 'F-11-01', 'việc phải neo đúng phát hiện đã sinh ra nó');
    assert.equal(step.kind, 'decision', 'bước phải nêu đúng kind của phát hiện');
    assert.equal(step.owner, 'A-04', 'người phải là chủ của loại tri thức, không phải người viết story');

    assert.equal(typeof step.action, 'string', 'phần "làm gì" phải là chữ');
    assert.ok(step.action.trim().length > 0, 'phần "làm gì" không được rỗng');
    assert.match(step.action, /decision/i, 'việc phải nói rõ loại decision nào');

    assert.equal(typeof step.whyNow, 'string', 'phần "vì sao bây giờ" phải là chữ');
    assert.ok(step.whyNow.trim().length > 0, 'phần "vì sao bây giờ" không được rỗng');

    assert.equal(typeof step.blocker, 'string', 'phần "cái chặn" phải là chữ');
    assert.ok(step.blocker.trim().length > 0, 'phần "cái chặn" không được rỗng — phải nêu cái gì đang chặn');

    assert.equal(step.playbook, 'docs/templates/decision-playbook.md', 'mẫu phải trỏ playbook của kind');

    // "việc đọc lại được" + BIP §1 idempotent: cùng đầu vào, cùng danh sách việc.
    const again = await nextActions({ project: 'project-alpha', findings, kindOwners, playbooks });
    assert.deepEqual(again.next, result.next, 'cùng đầu vào phải cho cùng danh sách việc');
});
