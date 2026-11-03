// X34 — "slice nào sở hữu AC nào" chỉ được có MỘT nguồn sự thật.
//
// Sự thật đó đang được ghi ở hai chỗ: dòng `DoD` của dictionary (`AC: ...`) và bảng §7 của packet.
// Khi hai chỗ lệch, ticket sinh từ chỗ này sẽ bị kiểm bằng chỗ kia — và `ESO-217` đã ra đời như thế:
// nó ghi *"không AC nào claim work package này"* rồi liệt kê 12 `AC-UI-01-*` ngay bên dưới.
//
// Test này KHÔNG quyết định chỗ nào đúng. Nó chỉ nói: hai chỗ phải giống nhau.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WBS = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc/09.wbs');
const AC = /AC-[A-Z]+-\d+-\d+/g;

// LUẬT ĐÚNG, sau khi bản đầu đặt sai: packet §7 **được phép** nhắc AC của slice khác (test phụ thuộc,
// ví dụ "RED: AC-X hỏng"). Cái KHÔNG được phép là slice **sở hữu** một AC mà test plan của nó **không**
// có dòng nào cho AC đó — tức tiêu chí nằm trên giấy mà không ai định kiểm nó.
test('X34: mọi AC một slice sở hữu đều có dòng trong §7 của nó', () => {
    assert.ok(existsSync(WBS), 'X34: không có sdlc/09.wbs — phép kiểm này không được phép bỏ qua');

    // 1. Nguồn thứ nhất — dòng `DoD` của mỗi work package
    const fromDict = new Map();
    for (const name of readdirSync(WBS).filter((n) => /deliverable-\d+(-split)?\.md$/.test(n))) {
        const text = readFileSync(join(WBS, name), 'utf8');
        for (const m of text.matchAll(/^### `(\d+\.\d+)` · /gm)) {
            const start = m.index + m[0].length;
            let end = text.indexOf('\n### ', start);
            if (end < 0) end = text.length;
            const dod = /^\| \*\*DoD\*\* \| (.+)$/m.exec(text.slice(start, end));
            fromDict.set(m[1], new Set((dod ? dod[1] : '').match(AC) || []));
        }
    }

    // 2. Nguồn thứ hai — chỉ các dòng bảng §7 của packet (BIP và FIP), không phải mọi chỗ nhắc tới AC
    const fromPacket = new Map();
    for (const dir of ['01.packets/01.bip', '01.packets/02.fip']) {
        const abs = join(WBS, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs).filter((n) => n.endsWith('.md'))) {
            const text = readFileSync(join(abs, name), 'utf8');
            const id = /^id: (?:BIP|FIP)-(\d+)_(\d+)/m.exec(text);
            if (!id) continue;
            // §7 có thể là mục cuối (không có §8) — cắt tới heading kế tiếp HOẶC hết file.
            const sec = /^## 7\.[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
            // §7 có hai định dạng: bảng test-plan (AC ở cột 1) và bảng luồng UI (AC ở cột cuối).
            // Cả hai đều là *claim*; nên lấy mọi dòng bảng, không chỉ dòng bắt đầu bằng AC.
            const rows = (sec ? sec[1] : '').split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l));
            fromPacket.set(`${id[1]}.${id[2]}`, new Set(rows.flatMap((r) => r.match(AC) || [])));
        }
    }

    const drift = [];
    for (const wp of new Set([...fromDict.keys(), ...fromPacket.keys()])) {
        const a = fromDict.get(wp) || new Set();
        const b = fromPacket.get(wp) || new Set();
        if (!a.size && !b.size) continue;
        // Chỉ kiểm một chiều: sở hữu ⇒ phải có test plan. Chiều ngược lại là hợp lệ.
        const untested = [...a].filter((x) => !b.has(x));
        if (untested.length) drift.push(`${wp}: sở hữu nhưng §7 không có [${untested.join(' ')}]`);
    }
    assert.deepEqual(drift, [], 'có tiêu chí được slice sở hữu mà test plan của nó không kiểm');
});
