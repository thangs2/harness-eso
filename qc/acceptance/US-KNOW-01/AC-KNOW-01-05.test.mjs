import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { inventoryKnowledge } = knowledge;

test('SCN-KNOW-05 · AC-KNOW-01-05 — loại không có chủ ⇒ nêu "loại X chưa có chủ"', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof inventoryKnowledge,
        'function',
        'inventoryKnowledge phải được export từ eso/knowledge/src/index.mjs',
    );

    const sources = [
        { kind: 'decision', locator: 'docs/decisions', owner: '', documents: ['d1.md', 'd2.md'] },
        { kind: 'policy', locator: 'docs/policies', owner: 'A-08', documents: ['p1.md'] },
    ];

    const result = await inventoryKnowledge({ project: 'project-ownerless', sources });

    const entry = result.kinds.find((row) => row.kind === 'decision');
    assert.ok(entry, 'loại chưa có chủ vẫn phải hiện trong danh sách');
    assert.ok(!entry.owner, 'chủ phải để trống, không được lấy một chủ mặc định');

    const gap = result.gaps.find((row) => row.kind === 'decision' && row.reason === 'missing-owner');
    assert.ok(gap, 'phần khuyết chủ phải được nêu trong gaps');
    assert.match(String(gap.message ?? ''), /loại decision chưa có chủ/i, 'phải nói rõ loại nào chưa có chủ');
});
