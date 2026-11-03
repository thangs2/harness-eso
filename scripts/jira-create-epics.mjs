#!/usr/bin/env node
// Tạo Epic cho mọi feature chưa có — idempotent: chạy lại chỉ tạo cái còn thiếu.
// Epic = Feature (D-78). Nguồn: 06.eso-features.md. Thứ tự + phụ thuộc: 00.jira/01.epic-map.md §3.
//
//   node scripts/jira-create-epics.mjs            # dry-run: liệt kê cái sẽ tạo/đã có
//   node scripts/jira-create-epics.mjs --apply
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

for (const line of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('⚠ JIRA_TLS_INSECURE=1 — KHÔNG kiểm chứng chứng chỉ TLS.');
}
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
if (!base || !process.env.JIRA_API_TOKEN) { console.error('ERROR: thiếu JIRA_* env'); process.exit(1); }

const call = async (method, path, body) => {
    const res = await fetch(base + path, {
        method, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return text.trim() ? JSON.parse(text) : {};
};

// Feature catalogue: id · tên · REQ · UC · US · trạng thái
const cat = readFileSync(join(ROOT, 'sdlc/06.analysis/01.business-analysis/06.eso-features.md'), 'utf8');
const features = [...cat.matchAll(/^\| \*\*(F-\d{2})\*\* \| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|/gm)]
    .map((m) => ({ id: m[1], name: m[2].trim(), req: m[3].trim(), uc: m[4].trim(), us: m[5].trim() }));

const plain = (t) => t.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
const code = (t) => '{{' + plain(t) + '}}';

// Thứ tự mở khoá (epic-map §3). blockedBy trỏ tới feature của bước trước; relates tới anh em cùng bước.
const STEPS = [
    { step: 1, ids: ['F-09'], by: [] },
    { step: 2, ids: ['F-05', 'F-13'], by: ['F-09'] },
    { step: 3, ids: ['F-01', 'F-02', 'F-03', 'F-04'], by: ['F-05'] },
    { step: 4, ids: ['F-06', 'F-07', 'F-08', 'F-10', 'F-15', 'F-16', 'F-14'], by: ['F-01'] },
    { step: 5, ids: ['F-11', 'F-12', 'F-17', 'F-18'], by: ['F-13'] },
    { step: 5, ids: ['F-19', 'F-20', 'F-21', 'F-22', 'F-23'], by: ['F-09'] },
];
const stepOf = new Map();
for (const s of STEPS) for (const id of s.ids) stepOf.set(id, s);

// Đã có epic nào? đọc label f-nn từ Jira.
const existing = new Map();
const jql = encodeURIComponent('project = ESO AND issuetype = Epic AND labels = epic');
const found = await call('GET', `/rest/api/2/search?jql=${jql}&fields=summary,labels&maxResults=100`).catch(async () => {
    // Jira Cloud mới bỏ /search — dùng endpoint mới
    return call('GET', `/rest/api/3/search/jql?jql=${jql}&fields=summary,labels&maxResults=100`);
});
for (const it of found.issues || []) {
    const f = (it.fields.labels || []).find((l) => /^f-\d\d$/.test(l));
    if (f) existing.set(f.toUpperCase().replace('F-', 'F-'), it.key);
}
// key thật của epic đã có (đọc lại cho chắc)
for (const [fid, key] of existing) existing.set(fid, key);

const desc = (x, st) => [
    'h3. Feature',
    `*${plain(x.name)}*`,
    '',
    `h3. Vì sao ở bước ${st.step}`,
    st.by.length ? `Cần ${st.by.map((b) => code(b)).join(' · ')} xong trước — xem {{00.jira/01.epic-map}} §3.` : 'Bước 1: mọi thứ khác cần ranh giới project và quyền trước.',
    '',
    'h3. Truy vết',
    `* REQ: ${code(x.req)}`,
    `* UC: ${code(x.uc)}`,
    `* US: ${code(x.us)}`,
    '',
    'h3. DoD (epic-level)',
    '*OPEN* — chưa viết cho feature này. `F-09` và `F-05` có DoD viết tay; 21 cái còn lại chờ.',
    '',
    'h3. Tài liệu',
    `* {{sdlc/06.analysis/01.business-analysis/06.eso-features}}`,
    `* {{sdlc/05.requirements/01.specification/03.frd}} — FRD của feature`,
].join('\n');

const order = STEPS.flatMap((s) => s.ids);
console.log(`DRY-RUN=${!apply} · ${features.length} feature · đã có epic: ${existing.size}\n`);

for (const s of STEPS) {
    console.log(`— bước ${s.step}: ${s.ids.join(' ')}`);
    for (const id of s.ids) {
        const x = features.find((f) => f.id === id);
        if (!x) { console.log(`   ⛔ ${id}: không có trong catalogue`); continue; }
        if (existing.has(id)) { console.log(`   –  ${id} đã có ${existing.get(id)}`); continue; }
        const siblings = s.ids.filter((o) => o !== id).map((o) => existing.get(o)).filter(Boolean);
        const blockedBy = s.by.map((b) => existing.get(b)).filter(Boolean);
        if (!apply) { console.log(`   +  ${id} — ${plain(x.name)} · bị chặn bởi ${blockedBy.join(',') || '—'}`); continue; }
        const fields = {
            project: { key: 'ESO' }, issuetype: { name: 'Epic' },
            summary: `${id} — ${plain(x.name)}`,
            description: desc(x, s),
            labels: ['epic', id.toLowerCase(), /^F-(19|2\d)$/.test(id) ? 'v2' : 'v1'],
        };
        const r = await call('POST', '/rest/api/2/issue', { fields });
        existing.set(id, r.key);
        console.log(`   ✅ ${r.key} — ${id} ${plain(x.name)}`);
        for (const k of blockedBy) {
            await call('POST', '/rest/api/2/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: k }, inwardIssue: { key: r.key } })
                .then(() => console.log(`      link ${k} blocks ${r.key}`))
                .catch((e) => console.log(`      ⛔ link ${k}→${r.key}: ${e.message}`));
        }
        for (const k of siblings) {
            await call('POST', '/rest/api/2/issueLink', { type: { name: 'Relates' }, outwardIssue: { key: r.key }, inwardIssue: { key: k } })
                .then(() => console.log(`      relates ${r.key} ↔ ${k}`))
                .catch((e) => console.log(`      ⛔ relates ${r.key}↔${k}: ${e.message}`));
        }
    }
}
console.log(apply ? `\ntổng epic: ${existing.size}` : '\nnothing written — pass --apply');
