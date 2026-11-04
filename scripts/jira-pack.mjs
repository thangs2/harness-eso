#!/usr/bin/env node
// Sinh Execution Pack từ một ticket ESO: tóm tắt · AC · spec miền · allowed_files · verify · cấm.
// Chuẩn 07 §9 + 09.deliverable-1 §1.5 (ESO-38).
//
// Usage:
//   node scripts/jira-pack.mjs ESO-24
//   ./scripts/jira-pack.sh ESO-24
//   node scripts/jira-pack.mjs ESO-24 --json

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const ticketKey = args.find((a) => !a.startsWith('-')) || '';

if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: scripts/jira-pack.sh <TICKET-KEY> [--json]');
    process.exit(0);
}

if (!ticketKey) {
    console.error('Usage: scripts/jira-pack.sh <TICKET-KEY> [--json]');
    process.exit(1);
}

// 1. Nạp biến môi trường từ .env
for (const l of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

// 2. Tải domain specs từ sdlc/01.agent-manifests/01.domains/
const DOMAINS_DIR = join(ROOT, 'sdlc/01.agent-manifests/01.domains');
const domainSpecs = [];
if (existsSync(DOMAINS_DIR)) {
    for (const f of readdirSync(DOMAINS_DIR).filter((n) => n.endsWith('.spec.md'))) {
        const text = readFileSync(join(DOMAINS_DIR, f), 'utf8');
        const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text);
        if (!fmMatch) continue;
        const fm = {};
        for (const line of fmMatch[1].split('\n')) {
            const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
            if (kv) {
                const key = kv[1];
                let val = kv[2].trim().replace(/^["']|["']$/g, '');
                if (val === '') {
                    // có thể là array dạng list
                    fm[key] = [];
                } else {
                    fm[key] = val;
                }
            } else if (/^\s*-\s*["']?([^"']+)["']?/.test(line)) {
                const item = line.trim().replace(/^-\s*["']?|["']?$/g, '');
                const lastKey = Object.keys(fm).pop();
                if (Array.isArray(fm[lastKey])) fm[lastKey].push(item);
            }
        }
        domainSpecs.push({ file: f, path: join('sdlc/01.agent-manifests/01.domains', f), ...fm });
    }
}

// 3. Lấy dữ liệu ticket (Online từ Jira API, fallback sang local WBS/packet nếu offline)
async function fetchTicket(key) {
    if (base && process.env.JIRA_API_TOKEN) {
        try {
            const SP = 'customfield_10016';
            const url = `${base}/rest/api/3/issue/${key}?fields=summary,issuetype,status,labels,parent,subtasks,issuelinks,description,${SP}`;
            const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
            if (res.ok) {
                const data = await res.json();
                return { source: 'jira', ...data };
            }
        } catch {}
    }
    return null;
}

const issueData = await fetchTicket(ticketKey);

// Parse ADF / text description
function extractDescriptionText(desc) {
    if (!desc) return '';
    if (typeof desc === 'string') return desc;
    function walk(node) {
        if (!node) return '';
        if (node.type === 'text') return node.text || '';
        if (node.type === 'hardBreak') return '\n';
        const inner = (node.content || []).map(walk).join('');
        if (node.type === 'heading') return '\n' + inner + '\n';
        if (node.type === 'paragraph' || node.type === 'codeBlock') return inner + '\n';
        if (node.type === 'listItem') return '- ' + inner.trim() + '\n';
        return inner;
    }
    return walk(desc);
}

const summary = issueData?.fields?.summary || `Ticket ${ticketKey}`;
const issueType = issueData?.fields?.issuetype?.name || 'Story';
const points = issueData?.fields?.customfield_10016 ?? null;
const labels = issueData?.fields?.labels || [];
const descText = extractDescriptionText(issueData?.fields?.description);

// Trích xuất Purpose P-01...P-07 nếu có
const purpose = [];
const pMatches = [...descText.matchAll(/(P-\d{2}[^:\n]*[:\s]+[^\n]+)/g)];
pMatches.forEach((m) => purpose.push(m[1].trim()));

// Trích xuất Acceptance Criteria
const acRows = [];
const acIds = [...new Set(descText.match(/AC-[A-Z]+-\d+-\d+/g) || [])];
const AC_DIR = join(ROOT, 'sdlc/06.analysis/03.acceptance-criteria');
const acMap = new Map();

if (existsSync(AC_DIR)) {
    for (const f of readdirSync(AC_DIR).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
        const text = readFileSync(join(AC_DIR, f), 'utf8');
        for (const line of text.split('\n')) {
            const m = /^\|\s*`?(AC-[A-Z]+-\d+-\d+)`?\s*\|\s*([^|]+)\|\s*[^|]+\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line);
            if (m) {
                acMap.set(m[1], {
                    id: m[1],
                    type: m[2].trim(),
                    preconditions: m[3].trim(),
                    trigger: m[4].trim(),
                    statement: m[5].trim(),
                });
            }
        }
    }
}

for (const id of acIds) {
    if (acMap.has(id)) {
        acRows.push(acMap.get(id));
    } else {
        acRows.push({ id, type: 'n/a', statement: 'Chi tiết trong analysis spec' });
    }
}

// 4. Map ticket sang Domain Spec
// Dựa vào labels (cap-kb, cap-arch, cap-ev, cap-iam, cap-cfg, cap-ui, cap-host...)
function resolveDomain(labels, summary, desc) {
    for (const l of labels) {
        if (l === 'cap-kb') return domainSpecs.find((d) => d.domain === 'eso/knowledge');
        if (l === 'cap-arch') return domainSpecs.find((d) => d.domain === 'eso/graph');
        if (l === 'cap-ev') return domainSpecs.find((d) => d.domain === 'eso/evidence');
        if (l === 'cap-iam' || l === 'cap-cfg') return domainSpecs.find((d) => d.domain === 'eso/control-plane');
        if (l === 'cap-ui') return domainSpecs.find((d) => d.domain === 'eso/ui');
        if (l === 'cap-host') return domainSpecs.find((d) => d.domain === 'eso/adapters');
    }
    if (/cô lập|project|knowledge|tri thức/i.test(summary)) return domainSpecs.find((d) => d.domain === 'eso/knowledge');
    if (/schema|extractor|graph|kiến trúc/i.test(summary)) return domainSpecs.find((d) => d.domain === 'eso/graph');
    if (/evidence|outbox|risk/i.test(summary)) return domainSpecs.find((d) => d.domain === 'eso/evidence');
    if (/control plane|policy|role|worker/i.test(summary)) return domainSpecs.find((d) => d.domain === 'eso/control-plane');
    return domainSpecs.find((d) => d.domain === 'eso/core') || domainSpecs[0];
}

const domain = resolveDomain(labels, summary, descText) || {
    domain: 'eso/core',
    path: 'sdlc/01.agent-manifests/01.domains/eso-core.spec.md',
    id: 'ESO_CORE_DOMAIN',
    allowed_files: ['eso/core/**', 'qc/eso-core-*.test.mjs'],
    forbidden: ['sdlc/**', 'packages/harness-*', 'docs/**'],
    verify: ['bun test qc/eso-core-*'],
};

// 5. Trích xuất verify command
let verifyCmd = Array.isArray(domain.verify) ? domain.verify[0] : domain.verify;
const verifyInDesc = /Verify[^\n]*\n+([^\n]+)/i.exec(descText);
if (verifyInDesc && /bun test/i.test(verifyInDesc[1])) {
    verifyCmd = verifyInDesc[1].replace(/<b>|<\/b>|`|\*|\s*\|\s*$/g, '').trim();
}

// 6. Đóng gói 6 mục chuẩn DoD
const pack = {
    ticket: ticketKey,
    type: issueType,
    summary,
    points,
    section_1_summary_and_purpose: {
        summary,
        points,
        purpose: purpose.length > 0 ? purpose : ['Thực thi tính năng theo AC của ticket và bất biến miền'],
    },
    section_2_acceptance_criteria: acRows,
    section_3_domain_spec: {
        domain: domain.domain,
        spec_path: domain.path,
        spec_id: domain.id,
        design_refs: domain.design_refs || [],
    },
    section_4_allowed_files: domain.allowed_files || [`${domain.domain}/**`],
    section_5_verify_command: verifyCmd || 'bun test',
    section_6_forbidden: domain.forbidden || ['sdlc/**', 'packages/harness-*', 'docs/**'],
};

if (jsonMode) {
    console.log(JSON.stringify(pack, null, 2));
    process.exit(0);
}

// In định dạng Markdown Execution Pack
console.log(`================================================================================`);
console.log(`EXECUTION PACK: ${ticketKey} (${issueType}) — ${points ?? '?'} SP`);
console.log(`================================================================================\n`);

console.log(`## 1. Tóm tắt (Summary & Purpose)`);
console.log(`- **Ticket**: ${ticketKey} [${issueType}] (${points ? `${points} SP` : 'Chưa gán điểm'})`);
console.log(`- **Summary**: ${summary}`);
if (purpose.length > 0) {
    console.log(`- **Purpose**:`);
    purpose.forEach((p) => console.log(`  - ${p}`));
}
console.log(``);

console.log(`## 2. Acceptance Criteria (AC in scope)`);
if (acRows.length > 0) {
    console.log(`| AC ID | Tiêu chí |`);
    console.log(`|---|---|`);
    acRows.forEach((r) => console.log(`| \`${r.id}\` | ${r.statement} |`));
} else {
    console.log(`*Không tìm thấy AC cụ thể trong description (xem spec miền)*`);
}
console.log(``);

console.log(`## 3. Spec miền (Domain Spec)`);
console.log(`- **Miền**: \`${domain.domain}\``);
console.log(`- **Spec Path**: [\`${domain.path}\`](${domain.path})`);
console.log(`- **Spec ID**: \`${domain.id}\``);
if (domain.design_refs && domain.design_refs.length > 0) {
    console.log(`- **Design References**:`);
    domain.design_refs.forEach((ref) => console.log(`  - \`${ref}\``));
}
console.log(``);

console.log(`## 4. allowed_files (Ranh giới ghi khóa cứng)`);
(domain.allowed_files || []).forEach((f) => console.log(`- \`${f}\``));
console.log(``);

console.log(`## 5. Verify command (Lệnh nghiệm thu)`);
console.log(`\`\`\`bash\n${verifyCmd}\n\`\`\``);
console.log(``);

console.log(`## 6. Cấm (Forbidden & Boundaries)`);
(domain.forbidden || []).forEach((f) => console.log(`- CẤM GHI: \`${f}\``));
console.log(`- CẤM TỰ CHẾ HỢP ĐỒNG: Chỉ tuân thủ theo DDL & Domain Spec`);
console.log(`- CẤM CLAIM THÀNH CÔNG NẾU CHƯA CHẠY VERIFY\n`);
console.log(`================================================================================`);
