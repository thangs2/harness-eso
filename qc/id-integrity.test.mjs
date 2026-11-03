// X37 / X38 — id phải trỏ tới thứ có thật, và frontmatter phải đủ field.
//
// Vì sao: `US-SUF-01`/`US-SUF-02` từng khai `req` bằng **blockquote** thay vì frontmatter, nên mọi parser thấy chúng
// không có yêu cầu, và **16 AC rơi khỏi mọi phép đếm theo REQ**. Không phép kiểm nào bắt vì không có phép kiểm nào
// đọc frontmatter của US.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDLC = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc');
const ANA = join(SDLC, '06.analysis');

test('X37: mỗi user story khai đủ `us` · `req` · `uc` · `actor`, và mọi id đều tồn tại', () => {
    const dir = join(ANA, '02.user-stories');
    assert.ok(existsSync(dir), 'X37: không có 02.user-stories');
    const files = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md');
    assert.ok(files.length >= 50, `X37: chỉ thấy ${files.length} user story`);

    const reqs = new Set(readFileSync(join(SDLC, '05.requirements/04.requirements.md'), 'utf8').match(/REQ-[A-Z]+-\d+/g));
    const ucs = new Set(readFileSync(join(ANA, '01.business-analysis/02.use-cases.md'), 'utf8').match(/UC-\d+/g));
    const actors = new Set(readFileSync(join(ANA, '01.business-analysis/01.actors.md'), 'utf8').match(/A-\d{2}/g));
    assert.ok(reqs.size >= 24 && ucs.size >= 10 && actors.size >= 6,
        `X37: catalogue rỗng (${reqs.size} REQ · ${ucs.size} UC · ${actors.size} actor)`);

    const bad = [];
    for (const n of files) {
        const t = readFileSync(join(dir, n), 'utf8');
        const f = (k) => new RegExp(`^${k}: (.+)$`, 'm').exec(t)?.[1]?.trim();
        const us = f('us'), req = f('req'), uc = f('uc'), actor = f('actor');
        for (const [k, v] of [['us', us], ['req', req], ['uc', uc], ['actor', actor]]) if (!v) bad.push(`${n}: thiếu \`${k}:\``);
        // Nhiều `REQ` trong một field là hợp lệ (một story phục vụ hai yêu cầu) — kiểm **từng** id, không áp luật một-`REQ`.
        if (req) for (const r of req.match(/REQ-[A-Z]+-\d+/g) || [])
            if (!reqs.has(r)) bad.push(`${n}: \`${r}\` không có trong register`);
        if (uc && !ucs.has(uc)) bad.push(`${n}: \`${uc}\` không có trong catalogue`);
        if (actor) for (const a of actor.match(/A-\d{2}/g) || []) if (!actors.has(a)) bad.push(`${n}: \`${a}\` không có trong catalogue`);
    }
    assert.deepEqual(bad.sort(), [], 'user story thiếu field hoặc trỏ id không tồn tại');
});

test('X38: id packet đúng hình dạng và trỏ tới slice có thật', () => {
    const wbs = join(SDLC, '09.wbs');
    const leaves = new Set();
    const deliverables = new Set();
    for (const n of readdirSync(wbs).filter((x) => /deliverable-\d+(-split)?\.md$/.test(x))) {
        const t = readFileSync(join(wbs, n), 'utf8');
        for (const m of t.matchAll(/^### `(\d+\.\d+)` · /gm)) { leaves.add(m[1]); deliverables.add(m[1].split('.')[0]); }
    }
    assert.ok(leaves.size >= 50, `X38: chỉ thấy ${leaves.size} work package`);

    // Ba hình dạng đang có trong cây — cả ba hợp lệ, nhưng phải trỏ tới thứ tồn tại.
    const SHAPES = [/^(?:BIP|FIP)-(\d+)_(\d+)(-OUT)?$/, /^(?:BIP|FIP)-(\d+)-OUT$/];
    const bad = [];
    for (const sub of ['01.packets/01.bip', '01.packets/02.fip']) {
        for (const n of readdirSync(join(wbs, sub)).filter((x) => x.endsWith('.md'))) {
            const t = readFileSync(join(wbs, sub, n), 'utf8');
            const id = /^id: (.+)$/m.exec(t)?.[1]?.trim();
            if (!id) { bad.push(`${n}: không có id`); continue; }
            if (!SHAPES.some((re) => re.test(id))) { bad.push(`${n}: id \`${id}\` sai hình dạng`); continue; }
            const m = /^(?:BIP|FIP)-(\d+)_(\d+)/.exec(id);
            if (m) {
                const slice = `${m[1]}.${m[2]}`;
                if (!leaves.has(slice)) bad.push(`${n}: id \`${id}\` trỏ slice \`${slice}\` không tồn tại`);
            } else {
                const d = /^(?:BIP|FIP)-(\d+)-OUT$/.exec(id)[1];
                if (!deliverables.has(d)) bad.push(`${n}: id \`${id}\` trỏ deliverable \`${d}\` không tồn tại`);
            }
        }
    }
    assert.deepEqual(bad.sort(), [], 'packet id sai hình dạng hoặc trỏ slice/deliverable không tồn tại');
});
