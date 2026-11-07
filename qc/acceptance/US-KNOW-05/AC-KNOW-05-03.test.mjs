import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { runConformance } = knowledge;

// SCN-KNOW-24 / AC-KNOW-05-03 (ED1): project có 0 tài liệu. Báo cáo vẫn đủ mọi phép kiểm;
// phép kiểm không áp dụng ghi `OUT` kèm lý do — không mục nào được vắng mặt.
const catalog = [
    {
        check_id: 'CHK-DECLARATIONS',
        title: 'mỗi declaration có bằng chứng',
        run: async () => ({ status: 'OUT', reason: 'project có 0 tài liệu — không có gì để kiểm' }),
    },
    {
        check_id: 'CHK-TEMPLATE',
        title: 'template có đòi ui-design',
        run: async () => ({ status: 'OUT', reason: 'template này không đòi ui-design' }),
    },
    {
        check_id: 'CHK-GRAPH-EVIDENCE',
        title: 'graph có bằng chứng',
        run: async () => ({ status: 'OUT', reason: 'project có 0 tài liệu — graph không có nguồn' }),
    },
    {
        check_id: 'CHK-CONFIG',
        title: 'config đọc được',
        run: async () => ({ status: 'pass', evidence: 'harness.config.json:1' }),
    },
];

test('SCN-KNOW-24 · AC-KNOW-05-03 — ED1 · 0 tài liệu ⇒ báo cáo vẫn đủ mọi phép kiểm, không áp dụng ghi OUT', async (t) => {
    // RED: `runConformance` chưa tồn tại trong index.mjs. Đỏ vì hành vi chưa có, không phải vì test sai cú pháp.
    assert.equal(
        typeof runConformance,
        'function',
        'runConformance phải được export từ eso/knowledge/src/index.mjs',
    );

    // ED1: project có `harness.config.json` nhưng 0 tài liệu.
    const projectRoot = mkdtempSync(join(tmpdir(), 'know-conformance-empty-'));
    writeFileSync(join(projectRoot, 'harness.config.json'), `${JSON.stringify({ project: 'project-empty' })}\n`);
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

    const report = await runConformance({ projectRoot, catalog });

    assert.ok(Array.isArray(report.verdicts), 'báo cáo phải có verdicts[] — mỗi phép kiểm đúng một dòng');
    assert.equal(
        report.verdicts.length,
        catalog.length,
        'INV-KB-04: báo cáo vẫn đủ mọi phép kiểm khi project rỗng — không mục nào vắng mặt',
    );

    for (const check of catalog) {
        const row = report.verdicts.find((verdict) => verdict.check_id === check.check_id);
        assert.ok(row, `INV-KB-04: ${check.check_id} phải có mặt trong báo cáo`);
        assert.ok(
            ['pass', 'fail', 'OUT'].includes(row.status),
            `${check.check_id} phải là pass · fail · OUT, thấy ${row.status}`,
        );
        if (row.status === 'OUT') {
            assert.equal(typeof row.reason, 'string', `${check.check_id}: OUT phải kèm lý do`);
            assert.ok(row.reason.trim().length > 0, `${check.check_id}: lý do của OUT không được rỗng`);
        }
        if (row.status === 'pass') {
            // FRD-F23 §2: `pass` phải kèm bằng chứng; pass không bằng chứng là không chạy.
            assert.equal(typeof row.evidence, 'string', `${check.check_id}: pass phải kèm evidence`);
            assert.ok(row.evidence.trim().length > 0, `${check.check_id}: evidence của pass không được rỗng`);
        }
    }

    const byId = Object.fromEntries(report.verdicts.map((verdict) => [verdict.check_id, verdict]));
    assert.equal(byId['CHK-CONFIG'].status, 'pass', 'phép kiểm chạy được trên project rỗng vẫn phải chạy');
    assert.equal(byId['CHK-DECLARATIONS'].status, 'OUT', 'phép kiểm không áp dụng vì 0 tài liệu phải là OUT');
    assert.equal(byId['CHK-GRAPH-EVIDENCE'].status, 'OUT', 'phép kiểm không áp dụng vì 0 tài liệu phải là OUT');
    assert.equal(
        report.status,
        'complete',
        'không có fail ⇒ complete; OUT kèm lý do không phải fail và không được biến thành fail',
    );
});
