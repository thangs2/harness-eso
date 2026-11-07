import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as knowledge from '../../../eso/knowledge/src/index.mjs';

const { runConformance } = knowledge;

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

// SCN-KNOW-26 / AC-KNOW-05-05: project KHÔNG nằm trong repo này. Conformance vẫn phải chạy được
// và báo cáo phải nêu đường dẫn project — không được đòi project nằm trong repo.
let seenProjectRoot = null;

const catalog = [
    {
        check_id: 'CHK-PATH',
        title: 'project root được truyền vào phép kiểm',
        run: async ({ projectRoot }) => {
            seenProjectRoot = projectRoot;
            return { status: 'pass', evidence: 'harness.config.json:1' };
        },
    },
    {
        check_id: 'CHK-OUT',
        title: 'template có đòi runbook',
        run: async () => ({ status: 'OUT', reason: 'template này không đòi runbook' }),
    },
];

test('SCN-KNOW-26 · AC-KNOW-05-05 — project ngoài repo vẫn chạy, báo cáo nêu đường dẫn project', async (t) => {
    // RED: `runConformance` chưa tồn tại trong index.mjs. Đỏ vì hành vi chưa có, không phải vì test sai cú pháp.
    assert.equal(
        typeof runConformance,
        'function',
        'runConformance phải được export từ eso/knowledge/src/index.mjs',
    );

    // Project nằm ngoài repo: thư mục tạm của hệ điều hành, không phải một thư mục con của harness-eso.
    const projectRoot = mkdtempSync(join(tmpdir(), 'know-conformance-outside-'));
    writeFileSync(join(projectRoot, 'harness.config.json'), `${JSON.stringify({ project: 'project-outside' })}\n`);
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    assert.ok(
        !realpathSync(projectRoot).startsWith(realpathSync(REPO_ROOT)),
        `fixture phải nằm ngoài repo: ${projectRoot}`,
    );

    // Không được ném lỗi chỉ vì project không nằm trong repo.
    const report = await runConformance({ projectRoot, catalog });

    assert.ok(Array.isArray(report.verdicts), 'báo cáo phải có verdicts[] — mỗi phép kiểm đúng một dòng');
    assert.equal(report.verdicts.length, catalog.length, 'INV-KB-04: mọi phép kiểm vẫn phải có kết quả');

    assert.equal(typeof report.projectRoot, 'string', 'báo cáo phải nêu đường dẫn project');
    assert.equal(
        realpathSync(report.projectRoot),
        realpathSync(projectRoot),
        'đường dẫn trong báo cáo phải là project đã chạy, không phải gốc repo',
    );
    assert.ok(seenProjectRoot, 'phép kiểm phải được gọi với projectRoot, không phải bị bỏ qua');
    assert.equal(
        realpathSync(seenProjectRoot),
        realpathSync(projectRoot),
        'phép kiểm phải nhận đúng projectRoot bên ngoài repo, không phải một hằng số',
    );

    const byId = Object.fromEntries(report.verdicts.map((verdict) => [verdict.check_id, verdict]));
    assert.equal(byId['CHK-PATH'].status, 'pass', 'phép kiểm trên project ngoài repo phải có kết quả thật');
    // FRD-F23 §2: `pass` phải kèm bằng chứng; pass không bằng chứng là không chạy.
    assert.equal(typeof byId['CHK-PATH'].evidence, 'string', 'pass phải kèm evidence');
    assert.ok(byId['CHK-PATH'].evidence.trim().length > 0, 'evidence của pass không được rỗng');
    assert.equal(byId['CHK-OUT'].status, 'OUT', 'OUT vẫn giữ nguyên trên project ngoài repo');
    assert.ok(byId['CHK-OUT'].reason.trim().length > 0, 'OUT phải kèm lý do');
});
