import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { inventoryKnowledge } = knowledge;

test('SCN-KNOW-04 · AC-KNOW-01-04 — 1 000 tài liệu · 12 loại ⇒ tổng theo loại', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof inventoryKnowledge,
        'function',
        'inventoryKnowledge phải được export từ eso/knowledge/src/index.mjs',
    );

    // ED3: 1 000 tài liệu thuộc 12 loại. Bốn loại 84, tám loại 83 ⇒ tổng 1 000.
    const counts = Array.from({ length: 12 }, (_, index) => (index < 4 ? 84 : 83));
    const kindOwners = {};
    const sources = counts.map((count, index) => {
        const suffix = String(index + 1).padStart(2, '0');
        const kind = `kind-${suffix}`;
        kindOwners[kind] = `A-${suffix}`;
        return {
            kind,
            custodian: 'repo',
            locator: `docs/kind-${suffix}`,
            documents: Array.from({ length: count }, (_, docIndex) => `docs/kind-${suffix}/doc-${docIndex}.md`),
        };
    });

    const result = await inventoryKnowledge({ project: 'project-large', sources, kindOwners });

    assert.equal(result.kinds.length, 12, 'phải tổng hợp đủ 12 loại, không cắt bớt');
    assert.equal(result.total, 1000, 'tổng phải khớp 1 000 tài liệu thật');
    assert.equal(
        result.kinds.reduce((sum, row) => sum + row.count, 0),
        1000,
        'tổng số lượng theo loại phải khớp tổng thật',
    );

    for (const source of sources) {
        const entry = result.kinds.find((row) => row.kind === source.kind);
        assert.ok(entry, `kind ${source.kind} phải có trong inventory`);
        assert.equal(entry.owner, kindOwners[source.kind], `owner của ${source.kind} phải suy ra từ kind`);
        assert.equal(entry.count, source.documents.length, `số lượng của ${source.kind} phải đúng`);
        assert.ok(entry.count > 0, `kind ${source.kind} phải có số lượng, không bị bỏ trắng`);
        assert.equal(entry.declared, true);
        assert.equal(entry.missing, null);
    }
});
