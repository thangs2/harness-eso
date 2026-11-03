#!/usr/bin/env node
// Assign issues to a sprint — ported from baplatform `scripts/jira-sprint-audit.sh`.
// Same two rules as `jira-create`: dry-run by default, and the token is read, never printed.
//
// Usage:
//   node scripts/jira-sprint.mjs --list                         # sprints of the board
//   node scripts/jira-sprint.mjs --sprint-id 12 --keys ESO-1,ESO-2
//   node scripts/jira-sprint.mjs --sprint-id 12 --jql "project = ESO AND labels = sprint-0"
//   … add --apply to write
//
// Env: JIRA_BASE_URL · JIRA_USER_EMAIL · JIRA_API_TOKEN. Board id via JIRA_BOARD_ID (default 69).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const email = process.env.JIRA_USER_EMAIL || '';
const token = process.env.JIRA_API_TOKEN || '';
const boardId = process.env.JIRA_BOARD_ID || '69';
if (!base || !email || !token) {
    console.error('ERROR: JIRA_BASE_URL, JIRA_USER_EMAIL and JIRA_API_TOKEN are required (env or .env).');
    process.exit(1);
}
// TLS: một số mạng nội bộ chặn CA (proxy MITM) — baplatform xử lý bằng cách bỏ kiểm chứng. Ở đây làm
// **tuỳ chọn có tên**: `JIRA_TLS_INSECURE=1`, và nói ra mỗi lần chạy. Không bao giờ bật ngầm.
if (process.env.JIRA_TLS_INSECURE === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('⚠ JIRA_TLS_INSECURE=1 — KHÔNG kiểm chứng chứng chỉ TLS. Chỉ dùng trong mạng nội bộ.');
}

const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

async function call(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
    return text.trim() ? JSON.parse(text) : {};
}

if (flag('--list') || flag('--sprints')) {
    const d = await call('GET', `/rest/agile/1.0/board/${boardId}/sprint?state=active,future`);
    for (const s of d.values || []) console.log(`${String(s.id).padStart(6)}  ${s.state.padEnd(7)} ${s.name}`);
    process.exit(0);
}

const sprintId = opt('--sprint-id');
const keysArg = opt('--keys');
const jql = opt('--jql');
const apply = flag('--apply');
if (!sprintId || (!keysArg && !jql)) {
    console.error('ERROR: --sprint-id plus either --keys or --jql');
    process.exit(2);
}

let keys = keysArg ? keysArg.split(',').map((k) => k.trim()).filter(Boolean) : [];
if (jql) {
    const d = await call('GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key&maxResults=500`);
    keys = (d.issues || []).map((i) => i.key);
}
console.log(`DRY-RUN=${!apply} · sprint=${sprintId} · issues: ${keys.length}\n${keys.join(', ')}\n`);
if (!apply) { console.log('nothing written — pass --apply to assign.'); process.exit(0); }

const r = await call('POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: keys });
console.log(`assigned ${keys.length} issue(s) to sprint ${sprintId}.`);
