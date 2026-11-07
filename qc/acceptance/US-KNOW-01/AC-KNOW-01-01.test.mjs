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

    // FRD-F19 §1: mỗi dòng có `kind` · `custodian` · `locator` · `owner` · `declared`/`missing` · `unseen`.
    // `owner` suy ra từ `kind` (bảng kindOwners), KHÔNG đọc từ tài liệu.
    const sources = [
        { kind: 'decision', custodian: 'repo', locator: 'docs/decisions', documents: ['d1.md', 'd2.md'] },
        { kind: 'policy', custodian: 'repo', locator: 'docs/policies', documents: ['p1.md'] },
        { kind: 'runbook', custodian: 'provider', locator: 'docs/runbooks', documents: ['r1.md', 'r2.md', 'r3.md'] },
    ];
    const kindOwners = { decision: 'A-04', policy: 'A-08', runbook: 'A-01' };
    const project = { id: 'project-alpha', kindOwners };

    const result = await inventoryKnowledge({ project, sources });

    assert.equal(result.total, 6, 'tổng tài liệu phải khớp tổng thật');
    assert.equal(result.kinds.length, 3, 'mỗi loại tri thức đúng một dòng');
    assert.deepEqual(result.unseen, [], 'đã thấy hết cây tài liệu ⇒ unseen rỗng');

    for (const source of sources) {
        const entry = result.kinds.find((row) => row.kind === source.kind);
        assert.ok(entry, `kind ${source.kind} phải có trong inventory`);
        assert.equal(entry.custodian, source.custodian, `custodian của ${source.kind} phải đúng`);
        assert.equal(entry.locator, source.locator, `locator của ${source.kind} phải đúng`);
        assert.equal(entry.owner, kindOwners[source.kind], `owner của ${source.kind} phải suy ra từ kind`);
        assert.equal(entry.count, source.documents.length, `số tài liệu của ${source.kind} phải đúng`);
        assert.equal(entry.declared, true, `${source.kind} mở được ⇒ declared`);
        assert.equal(entry.missing, null, `${source.kind} đã thấy ⇒ không có missing`);
        assert.equal(typeof entry.kind, 'string');
        assert.ok(entry.kind.length > 0, 'kind không được rỗng');
        assert.ok(entry.locator.length > 0, 'locator không được rỗng');
        assert.ok(entry.owner.length > 0, 'owner không được rỗng');
    }
});
