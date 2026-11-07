import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { inventoryKnowledge } = knowledge;

test('SCN-KNOW-01 · AC-KNOW-01-01 — inventory liệt kê kind · chỗ · chủ', async () => {
    // RED: hàm chưa tồn tại trong index.mjs. Đỏ vì thiếu hành vi, không phải vì test sai cú pháp.
    assert.equal(
        typeof inventoryKnowledge,
        'function',
        'inventoryKnowledge phải được export từ eso/knowledge/src/index.mjs',
    );

    const sources = [
        { kind: 'decision', locator: 'docs/decisions', owner: 'A-04', documents: ['d1.md', 'd2.md'] },
        { kind: 'policy', locator: 'docs/policies', owner: 'A-08', documents: ['p1.md'] },
        { kind: 'runbook', locator: 'docs/runbooks', owner: 'A-01', documents: ['r1.md', 'r2.md', 'r3.md'] },
    ];

    const result = await inventoryKnowledge({ project: 'project-alpha', sources });

    assert.equal(result.kinds.length, 3, 'mỗi loại tri thức đúng một dòng');

    for (const source of sources) {
        const entry = result.kinds.find((row) => row.kind === source.kind);
        assert.ok(entry, `kind ${source.kind} phải có trong inventory`);
        assert.equal(entry.locator, source.locator, `chỗ của ${source.kind} phải đúng`);
        assert.equal(entry.owner, source.owner, `chủ của ${source.kind} phải đúng`);
        assert.equal(typeof entry.kind, 'string');
        assert.ok(entry.kind.length > 0, 'kind không được rỗng');
        assert.ok(entry.locator.length > 0, 'chỗ không được rỗng');
        assert.ok(entry.owner.length > 0, 'chủ không được rỗng');
    }
});
