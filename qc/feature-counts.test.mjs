// X35 — con số "N AC" trên mỗi dòng feature phải bằng tổng AC thật của các US dòng đó nêu.
//
// Vì sao cần: đo 2026-11-03, **17/23 dòng sai**, và sai theo **hai kiểu khác nhau** — `F-01` ghi 9 (chỉ `US-SUF-01`), `F-09` ghi 3
// trong khi `US-KB-01` có **5**. Tức con số là di vật của những thời điểm khác nhau, không phải một phép đếm. `X30` không bắt được:
// nó so **số trong văn xuôi** với **số dòng**, còn đây là số trong **ô bảng** so với **bảng khác**.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANA = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc/06.analysis');

test('X35: mỗi feature ghi đúng số AC của các US nó sở hữu', () => {
    const catPath = join(ANA, '01.business-analysis/06.eso-features.md');
    assert.ok(existsSync(catPath), 'X35: không có bảng feature');

    const acDir = join(ANA, '03.acceptance-criteria');
    const files = readdirSync(acDir).filter((n) => n.endsWith('.md'));
    assert.ok(files.length > 0, 'X35: không có file AC nào — phép kiểm này không được phép bỏ qua');

    const perUs = new Map();
    for (const n of files) {
        const text = readFileSync(join(acDir, n), 'utf8');
        for (const m of text.matchAll(/^\| `(AC-[A-Z]+-\d+-\d+)`/gm)) {
            const p = m[1].split('-');
            const us = `US-${p[1]}-${p[2]}`;
            perUs.set(us, (perUs.get(us) ?? 0) + 1);
        }
    }
    assert.ok(perUs.size > 40, `X35: chỉ thấy ${perUs.size} US có AC — bảng AC có thể đã đổi hình dạng`);

    const rows = readFileSync(catPath, 'utf8').split('\n').filter((l) => /^\| \*\*F-\d{2}\*\*/.test(l));
    assert.ok(rows.length >= 20, `X35: chỉ thấy ${rows.length} dòng feature`);

    const bad = [];
    for (const line of rows) {
        const cells = line.split('|');
        const id = /F-\d{2}/.exec(cells[1])[0];
        const usCell = cells[6] ?? '';
        const claimed = new Set(usCell.match(/US-[A-Z]+-\d+/g) || []);
        const rng = /(US-[A-Z]+-)(\d+)…(\d+)/.exec(usCell);
        if (rng) for (let n = Number(rng[2]); n <= Number(rng[3]); n++) claimed.add(`${rng[1]}${String(n).padStart(2, '0')}`);
        const real = [...claimed].reduce((a, u) => a + (perUs.get(u) ?? 0), 0);
        const stated = /(\d+)\s*AC/.exec(cells[7] ?? '');
        if (!stated) { bad.push(`${id}: không ghi số AC`); continue; }
        if (Number(stated[1]) !== real) bad.push(`${id}: ghi ${stated[1]}, thật ${real} (${claimed.size} US)`);
    }
    assert.deepEqual(bad, [], 'số AC trên dòng feature không khớp bảng tiêu chí');
});
