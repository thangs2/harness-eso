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
// payload.json:
//   { "issues": [ { "type": "Epic|Story|Task|Subtask|Bug", "summary": "...", "description": "...",
//                   "labels": ["..."], "parent": "ESO-12", "sprint": 123 } ] }
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

const payload = JSON.parse(readFileSync(file, 'utf8'));
const issues = payload.issues || [];
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
    console.log(`— ${String(it.type).padEnd(8)} parent=${(it.parent || '—').padEnd(9)} · ${it.summary}`);
    if (!apply) continue;
    try {
        const r = await call('POST', '/rest/api/2/issue', { fields });
        console.log(`    ✅ created ${r.key}`);
        created++;
    } catch (e) {
        console.log(`    ⛔ ${e.message}`);
        failed++;
    }
}

if (apply) console.log(`\ncreated ${created} · failed ${failed}`);
else console.log('\nnothing written — pass --apply to create.');
process.exit(failed ? 1 : 0);
