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

    const sources = [
        { kind: 'decision', locator: 'docs/decisions', owner: 'A-04', documents: ['d1.md'] },
        {
            kind: 'policy',
            locator: 'docs/policies',
            owner: 'A-08',
            documents: [],
            readable: false,
            error: 'EACCES',
        },
    ];

    const result = await inventoryKnowledge({ project: 'project-broken', sources });

    assert.equal(result.kinds.length, 2, 'loại không đọc được không được bị bỏ khỏi danh sách');

    const broken = result.kinds.find((row) => row.kind === 'policy');
    assert.ok(broken, 'policy vẫn phải hiện dù không đọc được');
    assert.equal(broken.readable, false);
    assert.equal(broken.count, null, 'không đọc được là unknown, không phải 0 tài liệu');
    assert.match(String(broken.note ?? ''), /không đọc được/i, 'dòng của loại hỏng phải ghi "không đọc được"');

    const good = result.kinds.find((row) => row.kind === 'decision');
    assert.ok(good, 'loại đọc được vẫn phải còn');
    assert.equal(good.readable, true);

    const gap = result.gaps.find((row) => row.kind === 'policy' && row.reason === 'unreadable');
    assert.ok(gap, 'phần khuyết phải được nêu trong gaps');
    assert.match(String(gap.message ?? ''), /không đọc được/i);
});
