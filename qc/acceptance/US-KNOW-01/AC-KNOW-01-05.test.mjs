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

    // FRD-F19 §1 + §2: `owner` suy ra từ `kind`; kind không có trong bảng kindOwners ⇒ owner rỗng,
    // dòng vẫn hiện và khuyết chủ phải được nêu — không lấy một chủ mặc định.
    const sources = [
        { kind: 'decision', custodian: 'repo', locator: 'docs/decisions', documents: ['d1.md', 'd2.md'] },
        { kind: 'policy', custodian: 'repo', locator: 'docs/policies', documents: ['p1.md'] },
    ];
    const kindOwners = { policy: 'A-08' };

    const result = await inventoryKnowledge({ project: 'project-ownerless', sources, kindOwners });

    const entry = result.kinds.find((row) => row.kind === 'decision');
    assert.ok(entry, 'loại chưa có chủ vẫn phải hiện trong danh sách');
    assert.equal(entry.owner, '', 'chủ phải để trống, không được lấy một chủ mặc định');
    assert.equal(entry.declared, true, 'loại vẫn khai được; chỉ owner khuyết');
    assert.equal(entry.missing?.code, 'KIND_UNOWNED', 'mã lỗi FRD cho kind có instance nhưng không có owner');
    assert.match(
        String(entry.missing?.message ?? ''),
        /loại decision chưa có chủ/i,
        'phải nói rõ loại nào chưa có chủ',
    );

    const policy = result.kinds.find((row) => row.kind === 'policy');
    assert.equal(policy.owner, 'A-08');
    assert.equal(policy.missing, null);
    assert.deepEqual(result.unseen, [], 'khuyết chủ không phải phần không thấy');
});
