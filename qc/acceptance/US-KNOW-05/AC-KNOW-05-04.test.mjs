import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { runConformance } = knowledge;

// SCN-KNOW-25 / AC-KNOW-05-04 (ED10): danh mục phép kiểm trỏ tới một phép kiểm ĐÃ BỊ XOÁ.
// Mục đó vẫn phải nằm trong báo cáo, nêu "phép kiểm đã mất" (UC-17.1b), và KHÔNG được coi là pass.
const catalog = [
    {
        check_id: 'CHK-ALIVE',
        title: 'config đọc được',
        run: async () => ({ status: 'pass', evidence: 'harness.config.json:1' }),
    },
    {
        // Dòng còn trong danh mục, nhưng implementation của phép kiểm đã bị xoá: không còn `run`.
        check_id: 'CHK-DELETED',
        title: 'phép kiểm đã bị xoá',
    },
    {
        check_id: 'CHK-NOT-APPLICABLE',
        title: 'template có đòi ui-design',
        run: async () => ({ status: 'OUT', reason: 'template này không đòi ui-design' }),
    },
];

test('SCN-KNOW-25 · AC-KNOW-05-04 — ED10 · phép kiểm đã mất hiện trong báo cáo, không phải pass', async (t) => {
    // RED: `runConformance` chưa tồn tại trong index.mjs. Đỏ vì hành vi chưa có, không phải vì test sai cú pháp.
    assert.equal(
        typeof runConformance,
        'function',
        'runConformance phải được export từ eso/knowledge/src/index.mjs',
    );

    const projectRoot = mkdtempSync(join(tmpdir(), 'know-conformance-ed10-'));
    writeFileSync(join(projectRoot, 'harness.config.json'), `${JSON.stringify({ project: 'project-alpha' })}\n`);
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

    const report = await runConformance({ projectRoot, catalog });

    assert.ok(Array.isArray(report.verdicts), 'báo cáo phải có verdicts[] — mỗi phép kiểm đúng một dòng');
    assert.equal(
        report.verdicts.length,
        catalog.length,
        'INV-KB-04: phép kiểm đã mất vẫn chiếm một dòng — danh mục không được rút gọn cho vừa',
    );

    const gone = report.verdicts.find((verdict) => verdict.check_id === 'CHK-DELETED');
    assert.ok(gone, 'INV-KB-04: phép kiểm đã mất phải nằm trong báo cáo, không được im lặng bỏ qua');
    assert.notEqual(gone.status, 'pass', 'ED10: phép kiểm đã mất KHÔNG được coi là pass');
    assert.equal(gone.status, 'OUT', 'ED10: phép kiểm đã mất phải là OUT');
    assert.equal(typeof gone.reason, 'string', 'ED10: phép kiểm đã mất phải kèm lý do');
    assert.ok(gone.reason.includes('phép kiểm đã mất'), 'ED10: lý do phải nêu "phép kiểm đã mất" (UC-17.1b)');

    const alive = report.verdicts.find((verdict) => verdict.check_id === 'CHK-ALIVE');
    assert.equal(alive.status, 'pass', 'một phép kiểm đã mất không được kéo theo phép kiểm còn lại');
    // FRD-F23 §2: `pass` phải kèm bằng chứng; pass không bằng chứng là không chạy.
    assert.equal(typeof alive.evidence, 'string', 'pass phải kèm evidence');
    assert.ok(alive.evidence.trim().length > 0, 'evidence của pass không được rỗng');
});
