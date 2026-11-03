#!/usr/bin/env node
// Vá dữ liệu Jira theo dictionary + chuẩn 07. Dry-run mặc định.
//   node scripts/jira-repair.mjs                    # xem sẽ sửa gì
//   node scripts/jira-repair.mjs --apply            # sửa: description · link · label · ticket đã xong
//   node scripts/jira-repair.mjs --only=links --apply
//
// KHÔNG tự quyết ba thứ cần người: (a) Story↔Task khi dictionary đổi quyền sở hữu AC,
// (b) label `tdd-fe`/`tdd-e2e` ngoài 8 loại, (c) ticket claim AC mà dictionary không giao.
// Ba nhóm đó `jira-audit.mjs` báo, script này không đụng.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, buildDescription, planLinks, planEpicLinks, linkPayload, fixAdfMarkup, adfText } from './lib/eso-wbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (k) => !only.length || only.includes(k);
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
// Mục "Quan hệ" phải là bulletList — newline trong wiki bị Jira nuốt (đo trên ESO-34).
const hasRelationBullets = (doc) => {
    const blocks = (doc?.content || []).filter((n) => ['paragraph', 'heading', 'bulletList'].includes(n.type));
    for (let i = 0; i < blocks.length; i++) {
        const n = blocks[i];
        if (n.type === 'heading' && /^Quan hệ$/i.test((n.content || []).map((x) => x.text || '').join(''))) {
            return blocks.slice(i + 1, i + 3).some((b) => b.type === 'bulletList');
        }
    }
    return false;
};
// Bullet trong ADF đọc ra thành "- key: …" ⇒ bỏ tiền tố bullet trước khi so, nếu không lần chạy
// thứ hai sẽ tưởng description khác và PUT lại 49 ticket mỗi lần.
const norm = (t) => String(t ?? '').replace(/h3\.\s*/g, '').replace(/[{}*_]/g, '')
    .split('\n').map((l) => l.trim().replace(/^[-•]\s*/, '')).join(' ')
    .replace(/\s+/g, ' ').trim();

const { plan, links: depLinks } = buildPlan(ROOT);
const byId = new Map(plan.map((p) => [p.id, p]));

const issues = [];
let token;
do {
    const q = `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO ORDER BY key')}` +
        `&fields=summary,issuetype,status,labels,parent,subtasks,issuelinks,description,${SP}&maxResults=100${token ? `&nextPageToken=${token}` : ''}`;
    const d = await call('GET', q);
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
} while (token);

const byKey = new Map(issues.map((i) => [i.key, i]));
const type = (i) => i.fields.issuetype.name;
const keyOfWp = new Map();
for (const i of issues) {
    if (type(i) === 'Subtask') continue;
    for (const l of i.fields.labels || []) if (l.startsWith('wp-')) keyOfWp.set(l.slice(3), i.key);
}

const todo = { descriptions: [], handwritten: [], links: [], inverted: [], labels: [], close: [], markup: [], epicLinks: [], epicInverted: [], epicExtra: [] };

// ── ① description: rò Markdown (§7) + thiếu khai bốn quan hệ (§6.1)
if (want('descriptions')) {
    for (const [id, key] of keyOfWp) {
        const p = byId.get(id);
        const i = byKey.get(key);
        if (!p || !i) continue;
        if (p.done) continue;                                   // WP đã xong: để người quyết, không tự sinh lại
        const before = adfText(i.fields.description);
        const after = buildDescription(p, plain);
        if (norm(before) === norm(after) && hasRelationBullets(i.fields.description)) continue;
        // Chỉ viết lại ticket do generator sinh. Description người viết tay (ESO-24 — story đầu tiên)
        // không có heading "Work package" ⇒ KHÔNG đụng, chỉ báo.
        if (!/^\s*Work package/m.test(before)) { todo.handwritten.push({ key, id }); continue; }
        todo.descriptions.push({ key, id, before, after });
    }
}

// ── ①b markup rò rỉ trong description (§7) — sửa định dạng tại chỗ, KHÔNG đổi chữ
if (want('markup')) {
    for (const i of issues) {
        const doc = i.fields.description;
        if (!doc) continue;
        if (!/`[^`]+`|\*\*|\\\|/.test(adfText(doc))) continue;
        todo.markup.push({ key: i.key, doc: fixAdfMarkup(doc) });
    }
}

// ── ② link: thiếu · ngược chiều (xoá rồi tạo lại đúng chiều)
if (want('links')) {
    const blocks = new Map();
    for (const i of issues) for (const l of i.fields.issuelinks || []) {
        if (l.type.name !== 'Blocks') continue;
        const o = (l.outwardIssue || l.inwardIssue)?.key;
        if (!o) continue;
        const pair = l.outwardIssue ? [i.key, o] : [o, i.key];   // [blocker, blocked]
        blocks.set(pair.join('>'), { id: l.id, blocker: pair[0], blocked: pair[1] });
    }
    for (const l of depLinks) {
        const from = keyOfWp.get(l.blocker), to = keyOfWp.get(l.blocked);
        if (!from || !to) continue;
        if (blocks.has(`${from}>${to}`)) continue;
        const rev = blocks.get(`${to}>${from}`);
        if (rev) todo.inverted.push({ linkId: rev.id, blocker: from, blocked: to, was: `${to}>${from}` });
        else todo.links.push({ blocker: from, blocked: to });
    }
}

// ── ②b link Epic↔Epic — nguồn: epic-map §3 (cùng payload bug, nên cũng ngược chiều)
if (want('epic-links')) {
    const epicKey = new Map();
    for (const i of issues) {
        if (type(i) !== 'Epic') continue;
        const f = (i.fields.labels || []).find((l) => /^f-\d\d$/.test(l));
        if (f) epicKey.set(f.toUpperCase(), i.key);
    }
    const pairs = new Map();                     // "blocker>blocked" → linkId
    for (const i of issues) {
        if (type(i) !== 'Epic') continue;
        for (const l of i.fields.issuelinks || []) {
            if (l.type.name !== 'Blocks') continue;
            const o = (l.outwardIssue || l.inwardIssue)?.key;
            if (!o) continue;
            const [from, to] = l.outwardIssue ? [i.key, o] : [o, i.key];   // outwardIssue trên issue X ⇒ X chặn Y
            pairs.set(`${from}>${to}`, l.id);
        }
    }
    const expected = planEpicLinks();
    const wantPairs = new Set();
    for (const l of expected) {
        const from = epicKey.get(l.blocker), to = epicKey.get(l.blocked);
        if (!from || !to) continue;
        wantPairs.add(`${from}>${to}`);
        if (pairs.has(`${from}>${to}`)) continue;
        if (pairs.has(`${to}>${from}`)) todo.epicInverted.push({ linkId: pairs.get(`${to}>${from}`), blocker: from, blocked: to, was: `${to}>${from}` });
        else todo.epicLinks.push({ blocker: from, blocked: to, why: `${l.blocker}→${l.blocked} (bước ${l.step})` });
    }
    const flipping = new Set(todo.epicInverted.map((l) => l.was));
    for (const p2 of pairs.keys()) if (!wantPairs.has(p2) && !flipping.has(p2)) todo.epicExtra.push(p2);
}

// ── ③ label: subtask không mang `wp-<id>` ⇒ không truy được work package
if (want('labels')) {
    for (const i of issues) {
        if (type(i) !== 'Subtask') continue;
        const labels = i.fields.labels || [];
        if (labels.some((l) => l.startsWith('wp-'))) continue;
        const parent = byKey.get(i.fields.parent?.key);
        const wp = (parent?.fields.labels || []).find((l) => l.startsWith('wp-'));
        if (wp) todo.labels.push({ key: i.key, add: wp });
    }
}

// ── ④ work package dictionary ghi đã xong mà ticket còn mở
if (want('close')) {
    for (const p of plan.filter((x) => x.done)) {
        const key = keyOfWp.get(p.id);
        const i = key && byKey.get(key);
        if (i && i.fields.status?.statusCategory?.name !== 'Done') todo.close.push({ key, id: p.id, days: p.days });
    }
}

// ── In
console.log(`issue: ${issues.length} · WP ticket: ${keyOfWp.size} · DRY-RUN=${!apply}${only.length ? ` · only=${only}` : ''}`);
console.log(`\n① description cần viết lại: ${todo.descriptions.length}`);
for (const d of todo.descriptions.slice(0, 3)) console.log(`   ${d.key} ${d.id} — ${d.before.replace(/\s+/g, ' ').slice(0, 90)}…`);
console.log(`   ↳ description người viết tay (không đụng): ${todo.handwritten.length}${todo.handwritten.length ? ' — ' + todo.handwritten.map((x) => x.key).join(', ') : ''}`);
console.log(`①b markup rò rỉ cần sửa tại chỗ: ${todo.markup.length}${todo.markup.length ? ' — ' + todo.markup.slice(0, 12).map((x) => x.key).join(', ') + (todo.markup.length > 12 ? '…' : '') : ''}`);
console.log(`② link thiếu: ${todo.links.length} · link ngược chiều: ${todo.inverted.length}`);
for (const l of todo.inverted.slice(0, 9)) console.log(`   ⚠ ${l.blocker} → ${l.blocked} (đang là ${l.was}, link id ${l.linkId})`);
console.log(`②b link epic–epic: thiếu ${todo.epicLinks.length} · ngược chiều ${todo.epicInverted.length} · ngoài epic-map ${todo.epicExtra.length}`);
for (const l of todo.epicInverted.slice(0, 6)) console.log(`   ⚠ ${l.blocker} → ${l.blocked} (đang là ${l.was})`);
for (const x of todo.epicExtra.slice(0, 6)) console.log(`   ? ngoài epic-map: ${x}`);
console.log(`③ subtask thiếu label wp-*: ${todo.labels.length}`);
for (const l of todo.labels.slice(0, 8)) console.log(`   ${l.key} + ${l.add}`);
console.log(`④ ticket đã xong mà còn mở: ${todo.close.length}`);
for (const c of todo.close) console.log(`   ${c.key} ${c.id} — ${c.days} ngày ⇒ cần Done`);

if (!apply) { console.log('\nchưa sửa gì. Thêm --apply để ghi.'); process.exit(0); }

// ── Ghi
const failed = [];
let n = 0;
for (const d of todo.descriptions) {
    try { await call('PUT', `/rest/api/2/issue/${d.key}`, { fields: { description: d.after } }); n++; }
    catch (e) { failed.push(`description ${d.key}: ${e.message}`); }
}
console.log(`\n✔ description: ${n}/${todo.descriptions.length}`);
n = 0;
for (const m of todo.markup) {
    try { await call('PUT', `/rest/api/3/issue/${m.key}`, { fields: { description: m.doc } }); n++; }
    catch (e) { failed.push(`markup ${m.key}: ${e.message}`); }
}
console.log(`✔ markup: ${n}/${todo.markup.length}`);
n = 0;
for (const l of todo.inverted) {
    try {
        await call('DELETE', `/rest/api/2/issueLink/${l.linkId}`);
        await call('POST', '/rest/api/2/issueLink', linkPayload(l.blocker, l.blocked));
        n++;
    } catch (e) { failed.push(`invert ${l.blocker}->${l.blocked}: ${e.message}`); }
}
for (const l of todo.links) {
    try {
        await call('POST', '/rest/api/2/issueLink', linkPayload(l.blocker, l.blocked));
        n++;
    } catch (e) { failed.push(`link ${l.blocker}->${l.blocked}: ${e.message}`); }
}
console.log(`✔ link: ${n}/${todo.links.length + todo.inverted.length}`);
n = 0;
for (const l of todo.epicInverted) {
    try {
        await call('DELETE', `/rest/api/2/issueLink/${l.linkId}`);
        await call('POST', '/rest/api/2/issueLink', linkPayload(l.blocker, l.blocked));
        n++;
    } catch (e) { failed.push(`epic-invert ${l.blocker}->${l.blocked}: ${e.message}`); }
}
for (const l of todo.epicLinks) {
    try { await call('POST', '/rest/api/2/issueLink', linkPayload(l.blocker, l.blocked)); n++; }
    catch (e) { failed.push(`epic-link ${l.blocker}->${l.blocked}: ${e.message}`); }
}
console.log(`✔ link epic–epic: ${n}/${todo.epicLinks.length + todo.epicInverted.length}`);
n = 0;
for (const l of todo.labels) {
    const i = byKey.get(l.key);
    try { await call('PUT', `/rest/api/2/issue/${l.key}`, { fields: { labels: [...new Set([...(i.fields.labels || []), l.add])] } }); n++; }
    catch (e) { failed.push(`label ${l.key}: ${e.message}`); }
}
console.log(`✔ label: ${n}/${todo.labels.length}`);
// KHÔNG chuyển Done: chuẩn 07 §9.3 + BR-08 — máy không tự đặt Done, chỉ người chốt DoD.
for (const c of todo.close) console.log(`⏸ ${c.key} ${c.id}: để NGƯỜI chuyển Done (BR-08) — dictionary ghi ${c.days} ngày/đã tạo`);
if (failed.length) { console.log('\n✗ lỗi:'); for (const f of failed) console.log('  ' + f); process.exit(1); }
