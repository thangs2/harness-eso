// X36 — tính toàn vẹn của ma trận scenario.
//
// Bốn lỗi peer C tìm thấy ngày 2026-11-03, mỗi cái máy kiểm được:
//   1. `SCN` id sai khuôn (ví dụ `SCN-IAM-07b` — chữ thường cuối, không khớp mẫu chung).
//   2. `SCN` id xuất hiện nhưng **không nằm trong bảng nào** (một dòng lạc ra ngoài).
//   3. `SCN` trỏ `AC` **không tồn tại**.
//   4. Cùng một `SCN` id dùng cho **hai `AC` khác nhau** — mỗi id là một kịch bản, không phải nhãn dùng lại.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANA = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc/06.analysis');

test('X36: id SCN đúng khuôn, nằm trong bảng, trỏ AC có thật, không dùng lại', () => {
    const qcDir = join(ANA, '04.quality-control');
    assert.ok(existsSync(qcDir), 'X36: không có 04.quality-control');
    const files = readdirSync(qcDir).filter((n) => n.endsWith('.md'));
    assert.ok(files.length >= 8, `X36: chỉ thấy ${files.length} file ma trận`);

    const acDir = join(ANA, '03.acceptance-criteria');
    const acs = new Set();
    for (const n of readdirSync(acDir).filter((x) => x.endsWith('.md')))
        for (const m of readFileSync(join(acDir, n), 'utf8').matchAll(/^\| `(AC-[A-Z]+-\d+-\d+)`/gm)) acs.add(m[1]);
    assert.ok(acs.size > 300, `X36: chỉ thấy ${acs.size} AC — bảng tiêu chí có thể đã đổi hình dạng`);

    const badShape = [], unknownAc = [], defined = new Set();
    const usages = new Map();       // SCN → Set(AC)

    for (const n of files) {
        const text = readFileSync(join(qcDir, n), 'utf8');
        const lines = text.split('\n');
        let inTable = false;
        for (const line of lines) {
            const isRow = /^\|/.test(line);
            if (isRow && !inTable) inTable = true;
            if (!isRow) inTable = false;
            for (const m of line.matchAll(/\bSCN-[A-Z]+-\d+[a-z]?\b/g)) {
                const scn = m[0];
                if (!/^SCN-[A-Z]+-\d+$/.test(scn)) { badShape.push(`${n}: ${scn}`); continue; }
                // Nhắc lại trong văn xuôi là **hợp lệ** — chỉ id **không được định nghĩa ở bảng nào** mới là lỗi.
                // Bản đầu của kiểm này đánh dấu mọi lần nhắc ngoài bảng; đó là luật tôi tự đặt, không phải luật của cây.
                if (inTable) defined.add(scn);
                const rowAcs = (line.match(/AC-[A-Z]+-\d+-\d+/g) || []);
                if (rowAcs.length) {
                    for (const a of rowAcs) if (!acs.has(a)) unknownAc.push(`${n}: ${scn} → ${a}`);
                    const set = usages.get(scn) ?? new Set();
                    for (const a of rowAcs) set.add(a);
                    usages.set(scn, set);
                }
            }
        }
    }

    const reused = [...usages.entries()].filter(([, set]) => set.size > 1)
        .map(([scn, set]) => `${scn} → ${[...set].join(', ')}`);

    assert.deepEqual([...new Set(badShape)].sort(), [], 'SCN id sai khuôn');
    const allIds = new Set();
    for (const n of files) for (const m of readFileSync(join(qcDir, n), 'utf8').matchAll(/\bSCN-[A-Z]+-\d+\b/g)) allIds.add(m[0]);
    const undefinedIds = [...allIds].filter((x) => !defined.has(x)).sort();
    assert.deepEqual(undefinedIds, [], 'SCN được nhắc nhưng không có dòng bảng nào định nghĩa nó');
    assert.deepEqual([...new Set(unknownAc)].sort(), [], 'SCN trỏ AC không tồn tại');
    assert.deepEqual(reused.sort(), [], 'một SCN dùng cho nhiều AC khác nhau');
});
