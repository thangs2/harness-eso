#!/usr/bin/env node
// Jira Story roll-up: children → parent. Dry-run by default.
//
//   node scripts/jira-rollup.mjs ESO-405
//   node scripts/jira-rollup.mjs ESO-405 --apply
//   node scripts/jira-rollup.mjs --all --apply
//
// Rule: any child In Progress ⇒ Story In Progress; all children Human In Review/Done ⇒
// Story Human In Review. Never Story → Done. Source: 17.jira-slp-operating §6.1.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideParentStatus } from './lib/jira-rollup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const all = argv.includes('--all');
const keys = argv.filter((a) => /^[A-Z][A-Z0-9_]*-\d+$/.test(a));

for (const line of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');
if (!base || !process.env.JIRA_API_TOKEN || !process.env.JIRA_USER_EMAIL) {
    console.error('ERROR: thiếu JIRA_* env (.env)');
    process.exit(1);
}
if (!keys.length && !all) {
    console.error('Usage: node scripts/jira-rollup.mjs <STORY-KEY>... [--apply] | --all [--apply]');
    process.exit(2);
}

async function call(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 240)}`);
    return text.trim() ? JSON.parse(text) : {};
}

async function storyKeys() {
    if (keys.length) return keys;
    const out = [];
    let token;
    do {
        const jql = 'project = ESO AND issuetype = Story AND statusCategory != Done ORDER BY key';
        const q = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status,subtasks&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`;
        const d = await call('GET', q);
        out.push(...(d.issues || []).map((i) => i.key));
        token = d.nextPageToken;
    } while (token);
    return out;
}

async function applyTarget(key, target) {
    const { transitions = [] } = await call('GET', `/rest/api/3/issue/${key}/transitions`);
    const t = transitions.find((x) => x.to?.name === target);
    if (!t) throw new Error(`${key}: no transition to "${target}" (have: ${transitions.map((x) => x.to?.name).join(', ')})`);
    await call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    return t.name;
}

let failed = 0;
for (const key of await storyKeys()) {
    try {
        const story = await call('GET', `/rest/api/3/issue/${key}?fields=summary,status,subtasks`);
        const parent = story.fields.status.name;
        const children = (story.fields.subtasks || []).map((s) => s.fields?.status?.name || 'To Do');
        const target = decideParentStatus(parent, children);
        const childText = children.length ? children.join(', ') : '(none)';
        if (!target) {
            console.log(`${key}: ${parent} · children=[${childText}] → no change`);
            continue;
        }
        if (!apply) {
            console.log(`${key}: ${parent} · children=[${childText}] → ${target} (dry-run)`);
            continue;
        }
        const transition = await applyTarget(key, target);
        console.log(`${key}: ${parent} → ${target} (transition "${transition}")`);
    } catch (err) {
        failed++;
        console.error(`${key}: ERROR ${err.message}`);
    }
}
if (failed) process.exit(1);
