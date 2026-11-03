// X41 — `capability-spec` phải truy vết được tới hành vi.
//
// Luật do operator chốt 2026-11-03: một capability spec **phải** trỏ tới `US`/`AC`, không chỉ tới tài liệu kiến trúc.
// Trước luật này, 5/9 spec trỏ vào `07.technical` và mọi tài liệu ở đó **không chứa `US` nào** ⇒ 37/56 story không
// capability nào phủ, và không phép kiểm nào thấy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDLC = join(dirname(fileURLToPath(import.meta.url)), '..', 'sdlc');

test('X41: mỗi capability spec khai `refs` bằng id `US`/`AC` có thật', () => {
    const dir = join(SDLC, '01.agent-manifests/02.capabilities');
    assert.ok(existsSync(dir), 'X41: không có 02.capabilities');
    const files = readdirSync(dir).filter((n) => n.endsWith('.spec.md'));
    assert.ok(files.length >= 9, `X41: chỉ thấy ${files.length} capability spec`);

    const known = new Set();
    for (const n of readdirSync(join(SDLC, '06.analysis/02.user-stories')).filter((x) => x.endsWith('.md'))) {
        const m = /^us: (US-[A-Z]+-\d+)/m.exec(readFileSync(join(SDLC, '06.analysis/02.user-stories', n), 'utf8'));
        if (m) known.add(m[1]);
    }
    for (const n of readdirSync(join(SDLC, '06.analysis/03.acceptance-criteria')).filter((x) => x.endsWith('.md')))
        for (const m of readFileSync(join(SDLC, '06.analysis/03.acceptance-criteria', n), 'utf8').matchAll(/^\| `(AC-[A-Z]+-\d+-\d+)`/gm)) known.add(m[1]);
    assert.ok(known.size > 300, `X41: chỉ thấy ${known.size} id hành vi`);

    const bad = [];
    for (const n of files) {
        const t = readFileSync(join(dir, n), 'utf8');
        const refs = /^refs: "?([^"\n]+)"?$/m.exec(t)?.[1] ?? '';
        const ids = refs.match(/\b(?:US|AC)-[A-Z]+-\d+(?:-\d+)?\b/g) || [];
        if (!ids.length) { bad.push(`${n}: \`refs\` không nêu id US/AC nào`); continue; }
        const unknown = ids.filter((i) => !known.has(i));
        if (unknown.length) bad.push(`${n}: refs trỏ id không tồn tại → ${unknown.join(', ')}`);
    }
    assert.deepEqual(bad.sort(), [], 'capability spec không truy vết được tới hành vi');
});
