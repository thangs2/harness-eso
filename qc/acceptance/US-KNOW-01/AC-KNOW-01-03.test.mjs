import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { inventoryKnowledge } = knowledge;

test('SCN-KNOW-03 · AC-KNOW-01-03 — 0 tài liệu ⇒ "chưa có tri thức nào" + gợi ý', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof inventoryKnowledge,
        'function',
        'inventoryKnowledge phải được export từ eso/knowledge/src/index.mjs',
    );

    const project = { id: 'project-empty', kindOwners: {} };
    const result = await inventoryKnowledge({ project, sources: [] });

    assert.deepEqual(result.kinds, [], 'project 0 tài liệu thì không có dòng kind nào');
    assert.deepEqual(result.unseen, [], 'cây rỗng nhưng đã thấy hết ⇒ unseen rỗng');
    assert.equal(result.total, 0, 'tổng tài liệu phải là 0');
    // FRD-F19 §1: vòng đời `draft → collected → current | partial`, KHÔNG có `empty`.
    assert.equal(result.status, 'collected', 'FRD-F19 chỉ có `collected`, không có trạng thái `empty`');
    assert.notEqual(result.status, 'empty', '`empty` không nằm trong vòng đời FRD-F19 nên không được trả về');
    assert.notEqual(result.status, 'pass', 'không được coi ca 0 tài liệu là pass');
    assert.match(String(result.message ?? ''), /chưa có tri thức nào/i, 'phải nói rõ "chưa có tri thức nào"');
    assert.doesNotMatch(String(result.message ?? ''), /không đọc được/i, 'ca rỗng phải khác ca lỗi đọc');
    assert.ok(Array.isArray(result.suggestions), 'phải có gợi ý bước đầu');
    assert.ok(result.suggestions.length > 0, 'gợi ý bước đầu không được rỗng');
});
