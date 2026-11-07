#!/usr/bin/env node
// Kiểm toàn bộ project ESO theo chuẩn 07 — CHỈ ĐỌC, không sửa gì.
//   node scripts/jira-audit.mjs            # tóm tắt
//   node scripts/jira-audit.mjs --all      # in hết vi phạm (mặc định in 3 mẫu/nhóm)
//
// `jira-points-audit.mjs` chỉ kiểm §10 (điểm). Nó báo "0 vi phạm" trong khi cả 8 ticket
// ESO-34…39/216/227 không có một link nào, không có subtask, và description rò Markdown.
// Script này kiểm sáu nhóm còn lại, và kiểm luôn tính đúng đắn của subtask (07 §11.1).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWps, loadUs2F, planLinks, planEpicLinks, subtaskPlan, SUBTASK_KINDS, adfText, laneOf } from './lib/eso-wbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const showAll = process.argv.includes('--all');
for (const l of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
if (!base || !process.env.JIRA_API_TOKEN) { console.error('ERROR: thiếu JIRA_* env (.env)'); process.exit(1); }

const SP = 'customfield_10016';
const FIELDS = `summary,issuetype,status,labels,parent,subtasks,issuelinks,description,${SP}`;
const issues = [];
let token;
do {
    const q = `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO ORDER BY key')}&fields=${FIELDS}&maxResults=100${token ? `&nextPageToken=${token}` : ''}`;
    const res = await fetch(base + q, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) { console.error('HTTP', res.status, (await res.text()).slice(0, 200)); process.exit(1); }
    const d = await res.json();
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
} while (token);

const wps = loadWps(ROOT);
planLinks(wps); // (giữ chỗ gọi một nguồn; link cần có tính dưới đây)
const us2f = loadUs2F(ROOT);

const V = [];                                   // {code, sev, msg}
const add = (code, sev, msg) => V.push({ code, sev, msg });
const type = (i) => i.fields.issuetype.name;
const byKey = new Map(issues.map((i) => [i.key, i]));
const parentOf = (i) => i.fields.parent?.key || null;
const sp = (i) => { const v = i.fields[SP]; return v === null || v === undefined ? null : Number(v); };
const textOf = (i) => adfText(i.fields.description);
const kidsOf = (i) => issues.filter((x) => parentOf(x) === i.key);
const isDone = (i) => i.fields.status?.statusCategory?.name === 'Done';

// ── WP ticket ↔ dictionary
const tickets = new Map();                       // wp id → [issue]
for (const i of issues) {
    if (type(i) === 'Subtask') continue;
    for (const l of i.fields.labels || []) if (l.startsWith('wp-')) {
        const id = l.slice(3);
        tickets.set(id, [...(tickets.get(id) || []), i]);
    }
}
for (const w of wps.values()) {
    const t = tickets.get(w.id) || [];
    if (!t.length) { if (!w.done) add('wp-thiếu-ticket', 'hard', `${w.id} — dictionary có, Jira không`); continue; }
    if (t.length > 1) add('wp-trùng-ticket', 'hard', `${w.id} — ${t.map((x) => x.key).join(', ')}`);
    const i = t[0];
    if (w.done && !isDone(i)) add('wp-đã-xong-mà-mở', 'hard', `${i.key} ${w.id} — dictionary ghi 0 ngày/đã tạo, Jira ${i.fields.status.name}`);
    if (type(i) !== w.kind) add('sai-loại', 'hard', `${i.key} ${w.id} — chuẩn 07 §3 ⇒ ${w.kind}, Jira ${type(i)}`);
    if (w.kind === 'Story') {
        const acs = new Set(w.acs);
        const claimed = new Set((textOf(i).match(/AC-[A-Z]+-\d+-\d+/g) || []));
        const miss = [...acs].filter((a) => !claimed.has(a));
        const extra = [...claimed].filter((a) => !acs.has(a));
        if (miss.length) add('AC-thiếu-trong-ticket', 'hard', `${i.key} ${w.id} — dictionary claim ${acs.size} AC, ticket thiếu ${miss.length}: ${miss.slice(0, 4).join(',')}`);
        if (extra.length) add('AC-lạ-trong-ticket', 'hard', `${i.key} ${w.id} — ticket claim ${extra.length} AC mà dictionary không giao: ${extra.slice(0, 4).join(',')}`);
    }
}
for (const [id, ts] of tickets) if (!wps.has(id)) add('wp-lạ', 'warn', `${ts.map((x) => x.key).join(',')} — label wp-${id} không có trong dictionary`);

// ── Bốn quan hệ khai tường minh trong description (§6.1)
const REL_KEYS = ['subtasks', 'relates', 'blocks', 'blockedBy'];
for (const i of issues) {
    if (type(i) === 'Epic') continue;
    const t = textOf(i);
    // Subtask chỉ khai BA quan hệ — Jira cấm subtask có con (§6.2)
    const keys = type(i) === 'Subtask' ? REL_KEYS.filter((k) => k !== 'subtasks') : REL_KEYS;
    // Description đọc qua ADF: bullet thành "- key: …" ⇒ cho phép tiền tố bullet.
    const missing = keys.filter((k) => !new RegExp(`^[\\s\\-•*]*${k}:`, 'm').test(t));
    // §6.3 cưỡng chế ở *payload*; sau khi tạo, description là chỗ duy nhất còn kiểm được ⇒ warn, không hard.
    if (missing.length) add('quan-hệ-chưa-ghi-trên-ticket', 'warn', `${i.key} (${type(i)}) thiếu khai: ${missing.join(' · ')}`);
}

// ── Subtask đúng chuẩn §11.1
for (const i of issues) {
    if (type(i) === 'Subtask' && !(i.fields.subtasks || []).length && !(i.fields.labels || []).some((l) => l.startsWith('wp-')))
        add('subtask-mất-ngữ-cảnh', 'warn', `${i.key} — subtask không mang label wp-* (không truy được work package)`);
}
// Task 0 subtask: hợp lệ chỉ khi có `subtasks: none — lý do`; Story 0 subtask thì luôn sai (§6)
for (const [id, ts] of tickets) {
    const i = ts[0], w = wps.get(id);
    if ((i.fields.subtasks || []).length) continue;
    const declared = /^[\s\-•*]*subtasks:\s*none\s*—\s*\S/m.test(textOf(i));
    if (type(i) === 'Story') add('story-không-subtask', 'hard', `${i.key} ${id} — Story không có subtask nào`);
    else if (type(i) === 'Task' && !declared) add('task-không-subtask-không-lý-do', 'hard', `${i.key} ${id} — Task ${w?.days ?? '?'} ngày, 0 subtask, không khai "none — lý do" (§6.1)`);
}
// Lane hợp lệ theo 07 §11.1 (impl: be/fe/mo · unit: be/fe · qc: qc/fe — §11 dùng tdd-qc[fe] cho E2E)
const ALLOWED_LANES = {
    'tdd-impl': ['be', 'fe', 'mo'], 'tdd-unit': ['be', 'fe'], 'tdd-coverage': ['be'], 'tdd-qc': ['qc', 'fe'],
    'tdd-ba': ['ba'], 'tdd-perf': ['qc'], 'tdd-load': ['be'], 'tdd-stress': ['be'],
};
const storyTickets = [...tickets.entries()].map(([id, ts]) => ({ id, issue: ts[0] })).filter((x) => type(x.issue) === 'Story');
for (const { id, issue } of storyTickets) {
    const w = wps.get(id);
    const kids = kidsOf(issue);
    const kinds = kids.map((k) => (k.fields.labels || []).find((l) => l.startsWith('tdd-')));
    for (const k of kids) {
        const kind = (k.fields.labels || []).find((l) => l.startsWith('tdd-'));
        if (!kind) add('subtask-không-loại', 'hard', `${k.key} ${id} — không có label tdd-*`);
        else if (!SUBTASK_KINDS.includes(kind)) add('subtask-loại-ngoài-8', 'warn', `${k.key} ${id} — label ${kind} không nằm trong 8 loại của 07 §11.1 (xem §11: văn xuôi gọi nửa [fe] là tdd-fe)`);
        const lane = laneOf(k.fields.labels, k.fields.summary);
        const allowed = ALLOWED_LANES[kind];
        if (allowed && lane && !allowed.includes(lane)) add('subtask-sai-lane', 'hard', `${k.key} ${id} — ${kind} chỉ hợp lệ ở [${allowed.join('/')}], summary ghi [${lane}]`);
        if (lane === null) add('subtask-thiếu-lane', 'hard', `${k.key} ${id} — summary không có tiền tố [be]/[fe]/[qc] (07 §11)`);
    }
    const need = subtaskPlan(w, sp(issue) ?? 0);
    const have = (kind, lane) => kinds.some((k, idx) => k === kind && laneOf(kids[idx].fields.labels, kids[idx].fields.summary) === lane);
    const legacyFe = kinds.some((k) => k === 'tdd-fe');
    const legacyE2e = kinds.some((k) => k === 'tdd-e2e');
    for (const s of need) {
        if (s.lane === 'fe') {
            const ok = have(s.kind, 'fe') || (s.kind === 'tdd-impl' && legacyFe) || (s.kind === 'tdd-qc' && legacyE2e);
            if (!ok) add('subtask-thiếu', 'hard', `${issue.key} ${id} — story có UI (${w.acs.filter((a) => a.startsWith('AC-UI')).length} AC-UI) thiếu ${s.kind}[fe]`);
        } else if (!have(s.kind, s.lane)) add('subtask-thiếu', 'hard', `${issue.key} ${id} — thiếu ${s.kind}[${s.lane}]`);
    }
}

// ── Điểm (§10) — trùng luật với jira-points-audit nhưng gộp vào một báo cáo
const FIB = new Set([1, 2, 3, 5, 8, 13]);
for (const i of issues) {
    const t = type(i), v = sp(i), kids = t === 'Epic' ? kidsOf(i) : (i.fields.subtasks || []).map((s) => byKey.get(s.key)).filter(Boolean);
    if (v === null) { add('điểm-thiếu', 'hard', `${i.key} (${t})`); continue; }
    if (kids.length && ['Story', 'Task', 'Epic'].includes(t)) {
        const sum = kids.reduce((a, k) => a + (sp(k) ?? 0), 0);
        if (sum !== v) add('điểm-roll-up-lệch', 'hard', `${i.key} (${t}) = ${v}, con cộng ${sum}`);
    } else if (t !== 'Epic' && !FIB.has(v)) add('điểm-ngoài-fibonacci', 'hard', `${i.key} (${t}) = ${v}`);
    else if (t === 'Epic' && !kids.length && v !== 0) add('điểm-epic-rỗng', 'hard', `${i.key} = ${v}, phải 0`);
}

// ── Link: thiếu · ngược chiều · trùng relates
const blocksOf = new Map(), blockedByOf = new Map(), relatesOf = new Map();
for (const i of issues) {
    blocksOf.set(i.key, []); blockedByOf.set(i.key, []); relatesOf.set(i.key, []);
    for (const l of i.fields.issuelinks || []) {
        if (l.type.name === 'Blocks') {
            if (l.outwardIssue) blocksOf.get(i.key).push(l.outwardIssue.key);
            else if (l.inwardIssue) blockedByOf.get(i.key).push(l.inwardIssue.key);
        } else if (l.type.name === 'Relates') {
            const o = (l.outwardIssue || l.inwardIssue)?.key;
            if (o) relatesOf.get(i.key).push(o);
        }
    }
}
const keyOfWp = new Map([...tickets.entries()].map(([id, ts]) => [id, ts[0].key]));
const keyToWp = new Map([...keyOfWp.entries()].map(([id, k]) => [k, id]));
for (const l of planLinks(wps)) {
    const from = keyOfWp.get(l.blocker), to = keyOfWp.get(l.blocked);
    if (!from || !to) continue;
    if (blocksOf.get(from)?.includes(to)) continue;
    if (blocksOf.get(to)?.includes(from)) add('link-ngược-chiều', 'hard', `${from} (${l.blocker}) ↔ ${to} (${l.blocked}) — Jira nói ${l.blocked} chặn ${l.blocker}`);
    else add('link-thiếu', 'hard', `${from} (${l.blocker}) → ${to} (${l.blocked}) — không có link blocks`);
}
// ── Link Epic↔Epic theo epic-map §3 (trước 2026-11-03 tất cả ngược chiều vì payload)
const epicByFeature = new Map();
for (const i of issues) {
    if (type(i) !== 'Epic') continue;
    const f = (i.fields.labels || []).find((l) => /^f-\d\d$/.test(l));
    if (f) epicByFeature.set(f.toUpperCase(), i.key);
}
for (const l of planEpicLinks()) {
    const from = epicByFeature.get(l.blocker), to = epicByFeature.get(l.blocked);
    if (!from || !to) continue;
    if (blocksOf.get(from)?.includes(to)) continue;
    if (blocksOf.get(to)?.includes(from)) add('epic-link-ngược-chiều', 'hard', `${from} (${l.blocker}) ↔ ${to} (${l.blocked}) — epic-map §3 nói bước ${l.step}`);
    else add('epic-link-thiếu', 'hard', `${from} (${l.blocker}) → ${to} (${l.blocked}) — epic-map §3 bước ${l.step}`);
}

for (const i of issues) {
    const both = (blocksOf.get(i.key) || []).filter((k) => (relatesOf.get(i.key) || []).includes(k));
    if (both.length) add('link-trùng-relates', 'warn', `${i.key} — vừa Blocks vừa Relates với ${both.join(', ')}`);
}

// ── Description: rò markup (§7) · dòng verify còn OPEN (§9.1 #5)
for (const i of issues) {
    const t = textOf(i);
    // Chỉ ba dấu hiệu chắc chắn. "dòng kết thúc bằng |" đã bỏ: text hợp lệ vẫn có thể kết thúc bằng `|`.
    const leaks = [t.includes('`') && 'backtick', /\*\*/.test(t) && '**', /\\\|/.test(t) && '\\|'].filter(Boolean);
    if (leaks.length) add('description-rò-markup', 'hard', `${i.key} — ${leaks.join(' · ')}`);
    if (/\*OPEN\*/.test(t) && /Verify/.test(t) && type(i) !== 'Epic') add('verify-còn-OPEN', 'warn', `${i.key} (${type(i)}) — DoR #5 chưa có dòng verify`);
}

// ── In
const byCode = new Map();
for (const v of V) byCode.set(v.code, [...(byCode.get(v.code) || []), v]);
const hard = V.filter((v) => v.sev === 'hard').length;
console.log(`issue: ${issues.length} · WP dictionary: ${wps.size} · ticket WP: ${tickets.size} · link dictionary: ${planLinks(wps).length}`);
console.log(`\n${byCode.size} nhóm vi phạm · ${V.length} mục (${hard} hard · ${V.length - hard} warn)\n`);
for (const [code, arr] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sev = arr[0].sev === 'hard' ? '✗' : '⚠';
    console.log(`${sev} ${code}: ${arr.length}`);
    for (const x of (showAll ? arr : arr.slice(0, 3))) console.log(`    ${x.msg}`);
    if (!showAll && arr.length > 3) console.log(`    … +${arr.length - 3} (--all để in hết)`);
}
const outDir = join(ROOT, '.harness/jira');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'audit.json'), JSON.stringify(V, null, 2));
console.log(`\nchi tiết: .harness/jira/audit.json`);
process.exit(hard ? 1 : 0);
