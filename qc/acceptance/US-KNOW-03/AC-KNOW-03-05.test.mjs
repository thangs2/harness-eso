import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { nextActions } = knowledge;

test('SCN-KNOW-15 · AC-KNOW-03-05 — "cần cải thiện" ⇒ từ chối, nêu "thiếu nội dung hành động"', async () => {
    // RED: nextActions chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof nextActions,
        'function',
        'nextActions phải được export từ eso/knowledge/src/index.mjs',
    );

    // Phát hiện chỉ nói được "cần cải thiện" — không nói làm gì, nên không được hiển thị như một việc.
    const findings = [
        {
            id: 'F-15-01',
            kind: 'decision',
            code: 'MISSING_KIND',
            reason: 'cần cải thiện',
            consequence: 'không rõ',
        },
    ];
    const kindOwners = { decision: 'A-04' };
    const project = { id: 'project-vague', kindOwners };
    const playbooks = { decision: 'docs/templates/decision-playbook.md' };

    const result = await nextActions({ project, findings, playbooks });

    assert.deepEqual(result.next, [], 'không được hiển thị một việc không làm được gì');
    assert.equal(result.total, 0, 'việc mơ hồ không được đếm vào tổng việc');

    assert.equal(result.rejected.length, 1, 'phát hiện mơ hồ phải được nêu là bị từ chối, không im lặng');
    const [rejection] = result.rejected;
    assert.equal(rejection.finding, 'F-15-01', 'lý do từ chối phải neo đúng phát hiện');
    assert.match(
        String(rejection.reason ?? ''),
        /thiếu nội dung hành động/i,
        'lý do phải nói rõ "thiếu nội dung hành động"',
    );
});
