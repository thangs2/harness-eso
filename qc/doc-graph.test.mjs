// X39 / X40 — hai luật có trong cây mà chưa có phép kiểm.
//
// X39: `03.bip-fip` §Cấm: *"**never merge** BIP and FIP into one file"* ⇒ `type:` phải khớp thư mục.
// X40: `source_of_truth` phải là **một chiều**. Vòng A→B→A nghĩa là **không tài liệu nào là gốc**, và mọi câu
//      "nguồn là X" trong nhánh đó đều không xác định. Tự trỏ là hợp lệ — đó là cách tài liệu gốc khai mình.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDLC = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc');

test('X39: `type:` khớp thư mục packet — BIP và FIP không bao giờ nằm chung file', () => {
    const bad = [];
    let seen = 0;
    for (const [dir, want] of [['09.wbs/01.packets/01.bip', 'bip'], ['09.wbs/01.packets/02.fip', 'fip']]) {
        const abs = join(SDLC, dir);
        assert.ok(existsSync(abs), `X39: không có ${dir}`);
        const files = readdirSync(abs).filter((n) => n.endsWith('.md'));
        assert.ok(files.length > 0, `X39: ${dir} rỗng — không có gì để kiểm`);
        for (const n of files) {
            seen++;
            const t = readFileSync(join(abs, n), 'utf8');
            const type = /^type: (\w+)$/m.exec(t)?.[1];
            if (type !== want) bad.push(`${dir}/${n}: type=${type ?? '(không có)'}, phải là ${want}`);
        }
    }
    assert.ok(seen >= 50, `X39: chỉ thấy ${seen} packet`);
    assert.deepEqual(bad.sort(), [], 'packet khai type khác thư mục của nó');
});

test('X40: `source_of_truth` không có vòng', () => {
    const docs = new Map();          // path tương đối với repo → SoT khai
    const walk = (dir) => {
        for (const n of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, n.name);
            if (n.isDirectory()) { walk(full); continue; }
            if (n.name.endsWith('.md')) {
                const t = readFileSync(full, 'utf8');
                const m = /^source_of_truth: "?([^"\n]+)"?$/m.exec(t);
                if (m) docs.set(relative(join(SDLC, '..'), full), m[1].trim());
            }
        }
    };
    walk(SDLC);
    assert.ok(docs.size > 100, `X40: chỉ thấy ${docs.size} tài liệu khai source_of_truth`);

    const bad = [];
    for (const [a, target] of docs) {
        if (target === a) continue;                       // tự trỏ = tài liệu gốc, hợp lệ
        const b = docs.has(target) ? target : null;
        if (b && docs.get(b) === a) bad.push(`${a} ⟷ ${b}`);
    }
    assert.deepEqual([...new Set(bad)].sort(), [], 'hai tài liệu nhận nhau làm nguồn — không cái nào là gốc');
});
