import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { inventoryKnowledge } = knowledge;

test('SCN-KNOW-02 · AC-KNOW-01-02 — loại không đọc được vẫn hiện, ghi "không đọc được"', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof inventoryKnowledge,
        'function',
        'inventoryKnowledge phải được export từ eso/knowledge/src/index.mjs',
    );

    // FRD-F19 §2: `locator` không mở được ⇒ dòng đó là `missing` (LOCATOR_UNRESOLVED),
    // không bị bỏ khỏi danh sách; phần không thấy phải nêu ở `unseen` (UNSEEN_SCOPE).
    const sources = [
        { kind: 'decision', custodian: 'repo', locator: 'docs/decisions', documents: ['d1.md'] },
        {
            kind: 'policy',
            custodian: 'provider',
            locator: 'docs/policies',
            documents: [],
            error: 'EACCES',
        },
    ];
    const kindOwners = { decision: 'A-04', policy: 'A-08' };
    const project = { id: 'project-broken', kindOwners };

    const result = await inventoryKnowledge({ project, sources });

    assert.equal(result.kinds.length, 2, 'loại không đọc được không được bị bỏ khỏi danh sách');

    const broken = result.kinds.find((row) => row.kind === 'policy');
    assert.ok(broken, 'policy vẫn phải hiện dù không đọc được');
    assert.equal(broken.locator, 'docs/policies', 'locator hỏng vẫn phải giữ nguyên đường dẫn');
    assert.equal(broken.declared, false, 'locator không mở được ⇒ declared: false');
    assert.equal(broken.count, null, 'không đọc được là unknown, không phải 0 tài liệu');
    assert.equal(broken.missing?.code, 'LOCATOR_UNRESOLVED', 'mã lỗi FRD cho locator không mở được');
    assert.match(String(broken.missing?.message ?? ''), /không đọc được/i, 'dòng của loại hỏng phải ghi "không đọc được"');

    const good = result.kinds.find((row) => row.kind === 'decision');
    assert.ok(good, 'loại đọc được vẫn phải còn');
    assert.equal(good.declared, true);
    assert.equal(good.missing, null);

    const unseen = result.unseen.find(
        (row) => row.code === 'UNSEEN_SCOPE' && row.locator === 'docs/policies',
    );
    assert.ok(unseen, 'phần không thấy phải được nêu trong unseen');
    assert.match(String(unseen.message ?? ''), /không đọc được/i);
});
