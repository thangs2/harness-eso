#!/usr/bin/env node
// Kiểm Story Points theo standard 07 §10. Chỉ ĐỌC — không sửa gì.
//   node scripts/jira-points-audit.mjs
// Ba loại vi phạm: thiếu điểm · điểm ngoài Fibonacci · roll-up lệch.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const l of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
if (!base || !process.env.JIRA_API_TOKEN) { console.error('ERROR: thiếu JIRA_* env'); process.exit(1); }

const FIB = new Set([1, 2, 3, 5, 8, 13]);
const SP = 'customfield_10016';

const issues = [];
let token;
do {
    const q = `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ESO ORDER BY key`)}&fields=summary,issuetype,parent,subtasks,${SP}&maxResults=100${token ? `&nextPageToken=${token}` : ''}`;
    const res = await fetch(base + q, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) { console.error('HTTP', res.status, (await res.text()).slice(0, 200)); process.exit(1); }
    const d = await res.json();
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
} while (token);

const byKey = new Map(issues.map((i) => [i.key, i]));
// Con của **Epic** là issue có `parent` trỏ tới nó — KHÔNG phải `fields.subtasks` (đó là con của Story/Task).
const childrenOf = new Map();
for (const i of issues) {
    const p = i.fields.parent?.key;
    if (p) childrenOf.set(p, [...(childrenOf.get(p) || []), i.key]);
}
const sp = (i) => { const v = i.fields[SP]; return v === null || v === undefined ? null : Number(v); };
const type = (i) => i.fields.issuetype.name;
const kids = (i) => (type(i) === 'Epic' ? childrenOf.get(i.key) || [] : (i.fields.subtasks || []).map((s) => s.key));

const missing = [], notFib = [], badRoll = [];
for (const i of issues) {
    const t = type(i), v = sp(i), k = kids(i);
    if (v === null) { missing.push(`${i.key} (${t}) ${i.fields.summary}`); continue; }
    const rollable = ['Story', 'Task', 'Epic'].includes(t);
    if (rollable && k.length) {
        const sum = k.reduce((a, c) => a + (sp(byKey.get(c)) ?? 0), 0);
        if (sum !== v) badRoll.push(`${i.key} (${t}) = ${v}, nhưng con cộng lại ${sum} [${k.join('+')}]`);
    } else if (t === 'Subtask' || t === 'Bug' || (rollable && !k.length)) {
        if (t === 'Epic' && !k.length) { if (v !== 0) notFib.push(`${i.key} (Epic rỗng) = ${v}, phải là 0`); }
        else if (!FIB.has(v)) notFib.push(`${i.key} (${t}) = ${v}, không thuộc {1,2,3,5,8,13}`);
    }
}

const line = (label, arr) => { console.log(`\n${label}: ${arr.length}`); for (const x of arr) console.log('  ✗ ' + x); };
console.log(`issue: ${issues.length} · ${[...new Set(issues.map(type))].join(' · ')}`);
line('Thiếu điểm', missing);
line('Ngoài Fibonacci', notFib);
line('Roll-up lệch', badRoll);
const total = missing.length + notFib.length + badRoll.length;
console.log(total ? `\n${total} vi phạm` : '\n0 vi phạm');
process.exit(total ? 1 : 0);
