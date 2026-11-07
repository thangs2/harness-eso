import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { runConformance } = knowledge;

// SCN-KNOW-22 / AC-KNOW-05-01: project có `harness.config.json`; mọi phép kiểm trong danh mục
// phải có kết quả — `pass`, `fail`, hoặc `OUT` kèm lý do. Không phép kiểm nào được vắng mặt.
const catalog = [
    {
        check_id: 'CHK-EVIDENCE',
        title: 'mỗi declaration có bằng chứng',
        run: async () => ({ status: 'pass', evidence: 'consumer: docs/decisions/d1.md:1' }),
    },
    {
        check_id: 'CHK-MISSING-OWNER',
        title: 'mỗi kind có chủ',
        run: async () => ({ status: 'fail', evidence: 'consumer: docs/decisions/d1.md:12' }),
    },
    {
        check_id: 'CHK-NOT-APPLICABLE',
        title: 'template có đòi ui-design',
        run: async () => ({ status: 'OUT', reason: 'template này không đòi ui-design' }),
    },
];

test('SCN-KNOW-22 · AC-KNOW-05-01 — mọi phép kiểm trong danh mục có kết quả: pass · fail · OUT + lý do', async (t) => {
    // RED: `runConformance` chưa tồn tại trong index.mjs. Đỏ vì hành vi chưa có, không phải vì test sai cú pháp.
    assert.equal(
        typeof runConformance,
        'function',
        'runConformance phải được export từ eso/knowledge/src/index.mjs',
    );

    const projectRoot = mkdtempSync(join(tmpdir(), 'know-conformance-'));
    writeFileSync(join(projectRoot, 'harness.config.json'), `${JSON.stringify({ project: 'project-alpha' })}\n`);
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

    const report = await runConformance({ projectRoot, catalog });

    assert.ok(Array.isArray(report.verdicts), 'báo cáo phải có verdicts[] — mỗi phép kiểm đúng một dòng');
    assert.equal(
        report.verdicts.length,
        catalog.length,
        'INV-KB-04: không phép kiểm nào được vắng mặt — số dòng báo cáo = số phép kiểm trong danh mục',
    );

    for (const check of catalog) {
        const row = report.verdicts.find((verdict) => verdict.check_id === check.check_id);
        assert.ok(row, `INV-KB-04: ${check.check_id} phải có kết quả trong báo cáo`);
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
    assert.equal(byId['CHK-EVIDENCE'].status, 'pass', 'phép kiểm đạt phải là pass');
    assert.equal(byId['CHK-MISSING-OWNER'].status, 'fail', 'phép kiểm hỏng phải là fail');
    assert.equal(byId['CHK-NOT-APPLICABLE'].status, 'OUT', 'phép kiểm không áp dụng phải là OUT');
    assert.ok(
        byId['CHK-NOT-APPLICABLE'].reason.includes('không đòi ui-design'),
        'lý do OUT phải là lý do của chính phép kiểm, không phải câu chung',
    );
    assert.equal(report.status, 'partial', 'còn phép kiểm fail ⇒ báo cáo partial, không phải complete');
});
