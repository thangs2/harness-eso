import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { runConformance } = knowledge;

// SCN-KNOW-23 / AC-KNOW-05-02: một phép kiểm KHÔNG chạy được (thiếu dữ liệu) vẫn phải hiện
// `OUT` + lý do (UC-17.1a) và KHÔNG được bỏ khỏi báo cáo. Số dòng = số phép kiểm trong danh mục.
const catalog = [
    {
        check_id: 'CHK-RUNS',
        title: 'config đọc được',
        run: async () => ({ status: 'pass', evidence: 'harness.config.json:1' }),
    },
    {
        check_id: 'CHK-NEEDS-DATA',
        title: 'mỗi declaration có chủ',
        run: async () => ({ status: 'OUT', reason: 'thiếu dữ liệu: project chưa có declaration nào để kiểm' }),
    },
    {
        check_id: 'CHK-RUNS-TOO',
        title: 'kind đóng',
        run: async () => ({ status: 'pass', evidence: 'docs/decisions:1' }),
    },
];

test('SCN-KNOW-23 · AC-KNOW-05-02 — phép kiểm không chạy được vẫn hiện OUT + lý do, không bị bỏ', async (t) => {
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
        'INV-KB-04: danh mục không được rút gọn cho vừa — số dòng báo cáo = số phép kiểm trong danh mục',
    );

    const blocked = report.verdicts.find((verdict) => verdict.check_id === 'CHK-NEEDS-DATA');
    assert.ok(blocked, 'INV-KB-04: phép kiểm không chạy được vẫn phải nằm trong báo cáo, không bị bỏ');
    assert.equal(blocked.status, 'OUT', 'phép kiểm không chạy được phải là OUT, không phải pass hay fail');
    assert.equal(typeof blocked.reason, 'string', 'OUT phải kèm lý do');
    assert.ok(blocked.reason.trim().length > 0, 'lý do của OUT không được rỗng');
    assert.ok(
        blocked.reason.includes('thiếu dữ liệu'),
        'lý do phải nêu đúng cái thiếu (UC-17.1a), không phải câu chung',
    );

    for (const check of catalog) {
        const row = report.verdicts.find((verdict) => verdict.check_id === check.check_id);
        assert.ok(row, `INV-KB-04: ${check.check_id} phải có mặt trong báo cáo`);
        if (row.status === 'pass') {
            // FRD-F23 §2: `pass` phải kèm bằng chứng; pass không bằng chứng là không chạy.
            assert.equal(typeof row.evidence, 'string', `${check.check_id}: pass phải kèm evidence`);
            assert.ok(row.evidence.trim().length > 0, `${check.check_id}: evidence của pass không được rỗng`);
        }
    }
});
