#!/usr/bin/env node
// Tạo Story/Task cho toàn bộ work package — idempotent, dry-run mặc định.
//   node scripts/jira-create-backlog.mjs            # xem sẽ tạo gì
//   node scripts/jira-create-backlog.mjs --apply    # tạo issue + subtask + link
//
// Phân loại theo chuẩn 07 §3 (ba câu hỏi), KHÔNG theo cảm giác:
//   có AC (dictionary §DoD)  ⇒ Story, treo dưới epic của feature chiếm đa số AC
//   không có AC              ⇒ Task, độc lập (Epic = Feature — không có epic kỹ thuật)
//
// Ba lỗi của bản trước, và chỗ sửa:
//   ① không đọc `Phụ thuộc` ⇒ ticket không có `blocks`/`is blocked by` (chuẩn 07 §6) — nay đọc và tạo link.
//   ② không đi qua `jira-create.mjs` ⇒ bỏ luôn kiểm bốn quan hệ (§6.3) — nay khai tường minh trong description.
//   ③ chèn nguyên Markdown của dictionary ⇒ `**`, backtick, `\|` hiện nguyên dấu trên Jira (§7) — nay `mdToWiki`.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, buildDescription, planLinks, linkPayload, subtaskPlan } from './lib/eso-wbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const linksOnly = argv.includes('--links');
for (const l of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
if (!base || !process.env.JIRA_API_TOKEN) { console.error('ERROR: thiếu JIRA_* env (.env)'); process.exit(1); }

const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${t.slice(0, 240)}`);
    return t.trim() ? JSON.parse(t) : {};
};
const plain = (t) => String(t ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
const SP = 'customfield_10016';

// 1) Dictionary → plan (một nguồn: scripts/lib/eso-wbs.mjs)
const { plan, links: depLinks } = buildPlan(ROOT);
const done = plan.filter((p) => p.done);
const live = plan.filter((p) => !p.done);
for (const p of done) console.log(`  ⏭  ${p.id} — dictionary ghi đã xong (0 ngày) ⇒ KHÔNG tạo ticket`);

// 2) Issue đã có (label wp-<id>) — Subtask cũng mang label này, phải loại ra kẻo map trỏ vào subtask
const existing = new Map();
const byKey = new Map();
let token;
do {
    const q = `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO ORDER BY key')}` +
        `&fields=summary,issuetype,labels,status,parent,subtasks,issuelinks,${SP}&maxResults=100${token ? `&nextPageToken=${token}` : ''}`;
    const page = await call('GET', q);
    for (const i of page.issues) {
        byKey.set(i.key, i);
        if (i.fields.issuetype.name === 'Subtask') continue;
        for (const l of i.fields.labels || []) if (l.startsWith('wp-')) existing.set(l.slice(3), i.key);
    }
    token = page.nextPageToken;
} while (token);

const epics = new Map();
const found = await call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO AND issuetype = Epic')}&fields=summary,labels&maxResults=100`);
for (const i of found.issues) { const f = (i.fields.labels || []).find((l) => /^f-\d\d$/.test(l)); if (f) epics.set(f.toUpperCase(), i.key); }

const byKind = { Story: live.filter((p) => p.kind === 'Story'), Task: live.filter((p) => p.kind === 'Task') };
console.log(`DRY-RUN=${!apply} · WP ${plan.length} → bỏ ${done.length} đã xong · Story ${byKind.Story.length} · Task ${byKind.Task.length}`);
console.log(`đã có issue: ${existing.size} · link theo dictionary: ${depLinks.length}`);
if (linksOnly) {
    for (const p of live) console.log(`  ${p.id.padEnd(5)} ${p.kind.padEnd(5)} blocks=${p.blocks.join(',') || '—'} blockedBy=${p.blockedBy.join(',') || '—'}`);
    process.exit(0);
}

// 3) Tạo issue (+ subtask khi là Story)
const keyOf = new Map(existing);
const made = [], skipped = [], failed = [];
for (const p of live) {
    if (keyOf.has(p.id)) { skipped.push(p.id); continue; }
    const epic = p.feature ? epics.get(p.feature) : null;
    const fields = {
        project: { key: 'ESO' }, issuetype: { name: p.kind },
        summary: `${p.id} — ${plain(p.title)}`,
        labels: [p.kind.toLowerCase(), `wp-${p.id}`, ...(p.feature ? [p.feature.toLowerCase()] : []), 'needs-dor'],
        description: buildDescription(p, plain),
    };
    if (epic && p.kind === 'Story') fields.parent = { key: epic };
    if (p.kind === 'Task') fields[SP] = p.sp;
    if (!apply) {
        console.log(`  ${p.kind === 'Story' ? '+' : '·'} ${p.id.padEnd(5)} ${p.kind.padEnd(5)} epic=${(epic || '—').padEnd(7)} sp=${p.sp} sub=${p.kind === 'Story' ? subtaskPlan(p, p.sp).length : 'none'} · ${plain(p.title).slice(0, 46)}`);
        continue;
    }
    try {
        const r = await call('POST', '/rest/api/2/issue', { fields });
        keyOf.set(p.id, r.key);
        made.push(p.id);
        console.log(`  ✅ ${r.key} ${p.kind} ${p.id} sp=${p.sp}`);
        if (p.kind === 'Story') {
            let sum = 0;
            for (const s of subtaskPlan(p, p.sp)) {
                const sr = await call('POST', '/rest/api/2/issue', {
                    fields: {
                        project: { key: 'ESO' }, issuetype: { name: 'Subtask' }, parent: { key: r.key },
                        summary: `[${s.lane}] ${p.id} — ${s.title}`,
                        labels: ['subtask', s.kind, `wp-${p.id}`, ...(p.feature ? [p.feature.toLowerCase()] : [])],
                        description: `h3. Một bước nguyên tử\n${s.title} cho work package {{${p.id}}}.\n\nh3. Quan hệ\n` +
                            'subtasks: none — Jira cấm subtask có con (chuẩn 07 §6.2)\nrelates: none\nblocks: none\nblockedBy: none\n\n' +
                            'h3. Verify\n*OPEN* — người nhận điền lệnh verify',
                        [SP]: s.points,
                    },
                });
                sum += s.points;
                console.log(`      ${sr.key} ${s.kind}[${s.lane}] ${s.points}`);
            }
            await call('PUT', `/rest/api/2/issue/${r.key}`, { fields: { [SP]: sum } });
            console.log(`      = story ${sum} SP (roll-up)`);
        }
    } catch (e) { failed.push(`${p.id}: ${e.message}`); console.log(`  ⛔ ${p.id}: ${e.message}`); }
}

// 4) Link — chiều đã đo trên ESO-2 (2026-11-03): outwardIssue = cái CHẶN, inwardIssue = cái BỊ CHẶN
const linked = new Set();
for (const i of byKey.values()) for (const l of i.fields.issuelinks || []) {
    const other = (l.outwardIssue || l.inwardIssue)?.key;
    if (!other) continue;
    if (l.type.name === 'Blocks') linked.add(l.outwardIssue ? `${i.key}>${other}` : `${other}>${i.key}`);
    else if (l.type.name === 'Relates') linked.add(`~${[i.key, other].sort().join('<>')}`);
}
const want = [], inverted = [];
for (const l of depLinks) {
    if (!keyOf.has(l.blocker) || !keyOf.has(l.blocked)) continue;
    const from = keyOf.get(l.blocker), to = keyOf.get(l.blocked);
    if (linked.has(`${from}>${to}`)) continue;
    if (linked.has(`${to}>${from}`)) { inverted.push({ ...l, from, to }); continue; }
    want.push({ ...l, from, to });
}
console.log(`\nlink: cần tạo ${want.length} · đã đúng ${depLinks.length - want.length - inverted.length} · ⚠ ngược chiều ${inverted.length}`);
for (const l of inverted) console.log(`  ⚠ ${l.from} (${l.blocker}) ↔ ${l.to} (${l.blocked}): Jira đang nói ${l.blocked} chặn ${l.blocker} — phải đảo (dùng jira-repair.mjs)`);
if (apply) {
    let ok = 0;
    for (const l of want) {
        try {
            await call('POST', '/rest/api/2/issueLink', linkPayload(l.from, l.to));
            ok++;
        } catch (e) { failed.push(`link ${l.from}->${l.to}: ${e.message}`); }
    }
    console.log(`  tạo ${ok}/${want.length} link`);
}

console.log(`\n${apply ? `tạo ${made.length} issue` : `${live.length - skipped.length} việc sẽ tạo`} · bỏ qua ${skipped.length + done.length} · lỗi ${failed.length}`);
if (failed.length) { for (const f of failed) console.log('  ✗ ' + f); process.exit(1); }
