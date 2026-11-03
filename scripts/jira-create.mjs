#!/usr/bin/env node
// Create Jira issues from a JSON payload — ported from baplatform `scripts/jira-bulk.sh --create`.
//
// The two properties worth keeping from that script, and the reason this is a port rather than a rewrite:
//   1. **dry-run is the default.** Nothing is written without `--apply`. A tool that creates 200 issues on a typo is a tool
//      that gets deleted after the first typo.
//   2. **it never prints the token.** Auth comes from the environment and is only ever read.
//
// Usage:
//   node scripts/jira-create.mjs --file payload.json            # dry-run: what would be created
//   node scripts/jira-create.mjs --file payload.json --apply    # create for real
//
// payload.json — mỗi issue phải khai **bốn quan hệ** (standard 07 §6):
//   { "issues": [ { "type": "Epic|Story|Task|Subtask|Bug", "summary": "...", "description": "...",
//                   "labels": ["..."], "parent": "ESO-12", "sprint": 123, "storyPoints": 5,
//                   "subtasks": ["..."], "relates": ["ESO-4"], "blocks": ["ESO-9"], "blockedBy": ["ESO-2"],
//                   "why": "bắt buộc khi một trong bốn mảng rỗng" } ] }
//
// Env: JIRA_BASE_URL · JIRA_USER_EMAIL · JIRA_API_TOKEN (required). Reads `.env` at the repo root if present.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag('--help') || flag('-h')) {
    console.log('node scripts/jira-create.mjs --file payload.json [--apply]');
    process.exit(0);
}

const file = opt('--file');
if (!file) { console.error('ERROR: --file is required'); process.exit(2); }
const apply = flag('--apply');

// .env at repo root — same convention as the source script, never committed (see .gitignore)
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

// Luật bốn quan hệ (standard 07 §6) — kiểm TRƯỚC khi in ra bất cứ gì. Không có cờ nào tắt.
// Jira render **wiki markup**, không phải Markdown. Gửi Markdown thì API trả 201 và ticket hiện nguyên dấu — sai
// im lặng ở cả hai đầu (standard 07 §7). Chặn ngay tại đây thay vì để người đọc ticket phát hiện.
const MD = [
    [/\*\*(.+?)\*\*/, 'in đậm: dùng *chữ* không phải **chữ**'],
    [/`[^`]+`/, 'monospace: dùng {{chữ}} không phải `chữ`'],
    [/^###?\s/m, 'tiêu đề: dùng "h3. " không phải "### "'],
    [/^\s*-\s/m, 'gạch đầu dòng: dùng "* " không phải "- "'],
];
const REQUIRED = ['subtasks', 'relates', 'blocks', 'blockedBy'];
function violations(it, i) {
    const out = [];
    const isSubtask = String(it.type).toLowerCase() === 'subtask';
    const keys = isSubtask ? REQUIRED.filter((k) => k !== 'subtasks') : REQUIRED;
    for (const k of keys) {
        if (!Array.isArray(it[k])) { out.push(`issue[${i}] ${it.summary || '(no summary)'}: thiếu "${k}"`); continue; }
        if (it[k].length === 0 && !it.why) out.push(`issue[${i}] ${it.summary || '(no summary)'}: "${k}" rỗng mà không có "why"`);
    }
    for (const [re, msg] of MD) {
        if (re.test(it.description || '')) out.push(`issue[${i}] ${it.summary || '(no summary)'}: ${msg}`);
    }
    return out;
}

const payload = JSON.parse(readFileSync(file, 'utf8'));
const issues = payload.issues || [];
const bad = issues.flatMap(violations);
if (bad.length) {
    console.error('REFUSED — vi phạm luật ticket (standard 07 §6 bốn quan hệ · §7 wiki markup):');
    for (const b of bad) console.error('  ✗ ' + b);
    console.error(`\n${bad.length} vi phạm · không ghi gì.`);
    process.exit(3);
}
const project = payload.project || 'ESO';
console.log(`DRY-RUN=${!apply} · project=${project} · issues to create: ${issues.length}\n`);

let created = 0, failed = 0;
for (const it of issues) {
    const fields = {
        project: { key: project },
        issuetype: { name: it.type },
        summary: it.summary,
        description: it.description || '',
        labels: it.labels || [],
    };
    if (it.parent) fields.parent = { key: it.parent };
    if (it.sprint) fields.customfield_10020 = Number(it.sprint);
    // Standard 07 §10: Story/Task có con thì điểm là **tổng của con**, không nhập tay.
    // Nhập tay ở đây là nguồn thứ hai, và nó lệch ngay lần đầu ai đó sửa một subtask.
    const rollable = ['Story', 'Task', 'Epic'].includes(it.type) && (it.subtasks || []).length > 0;
    if (rollable) {
        if (it.storyPoints !== undefined) {
            console.warn(`    ⚠ ${it.summary}: bỏ storyPoints nhập tay — điểm là tổng của ${it.subtasks.length} con (chạy jira-points-audit để kiểm).`);
        }
    } else if (it.storyPoints !== undefined) {
        fields.customfield_10016 = Number(it.storyPoints);
    }
    console.log(`— ${String(it.type).padEnd(8)} parent=${(it.parent || '—').padEnd(9)} · sub=${it.subtasks?.length ?? '—'} rel=${it.relates?.length ?? '—'} blocks=${it.blocks?.length ?? '—'} by=${it.blockedBy?.length ?? '—'} · ${it.summary}`);
    if (!apply) continue;
    try {
        const r = await call('POST', '/rest/api/2/issue', { fields });
        console.log(`    ✅ created ${r.key}`);
        created++;

        // Bốn quan hệ đã khai phải TRỞ THÀNH link thật, nếu không thì luật chỉ là hình thức.
        // Chiều Blocks: ĐO 2026-11-03 — payload {inwardIssue: blocker, outwardIssue: blocked} mới ra
        // "blocker blocks blocked". Bản trước tin docs ("outward = blocks") nên mọi link bị ngược chiều.
        // Relates: id 10003 — hai chiều, chiều nào cũng được.
        const links = [
            ...(it.blocks || []).map((k) => ({ type: 'Blocks', blocker: r.key, blocked: k })),
            ...(it.blockedBy || []).map((k) => ({ type: 'Blocks', blocker: k, blocked: r.key })),
            ...(it.relates || []).map((k) => ({ type: 'Relates', outward: r.key, inward: k })),
        ];
        for (const l of links) {
            try {
                const body = l.type === 'Blocks'
                    ? { type: { name: 'Blocks' }, inwardIssue: { key: l.blocker }, outwardIssue: { key: l.blocked } }
                    : { type: { name: 'Relates' }, outwardIssue: { key: l.outward }, inwardIssue: { key: l.inward } };
                await call('POST', '/rest/api/2/issueLink', body);
                console.log(`        link ${l.type}: ${l.blocker ?? l.outward} → ${l.blocked ?? l.inward}`);
            } catch (e) {
                console.log(`        ⛔ link ${l.type} ${l.outward}→${l.inward}: ${e.message}`);
                failed++;
            }
        }
    } catch (e) {
        console.log(`    ⛔ ${e.message}`);
        failed++;
    }
}

if (apply) console.log(`\ncreated ${created} · failed ${failed}`);
else console.log('\nnothing written — pass --apply to create.');
process.exit(failed ? 1 : 0);
