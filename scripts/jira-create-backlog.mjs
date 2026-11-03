#!/usr/bin/env node
// Tạo Story/Task cho toàn bộ work package — idempotent, dry-run mặc định.
//
// Phân loại theo chuẩn 07 §3 (ba câu hỏi), KHÔNG theo cảm giác:
//   có AC (claim trong packet §7)  ⇒ Story, treo dưới epic của feature chiếm đa số AC
//   không có AC                    ⇒ Task, độc lập (Epic = Feature — không có epic kỹ thuật)
// Ước lượng ngày → Story Point Fibonacci, theo bảng DAYS2SP dưới đây.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
for (const l of (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${t.slice(0, 200)}`);
    return t.trim() ? JSON.parse(t) : {};
};
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const list = (pat) => { const out = []; for (const f of readdirSync(join(ROOT, dirname(pat)))) if (new RegExp(pat.split('/').pop()).test(f)) out.push(join(dirname(pat), f)); return out; };
import { readdirSync } from 'node:fs';

// 1) Work packages
const wbsDir = 'sdlc/09.wbs';
const wp = new Map();
for (const f of readdirSync(join(ROOT, wbsDir)).filter((n) => /deliverable-\d+(-split)?\.md$/.test(n))) {
    const s = read(`${wbsDir}/${f}`);
    for (const m of s.matchAll(/^### `(\d+\.\d+)` · (.+)$/gm)) {
        const blk = s.slice(m.index + m[0].length);
        const end = blk.indexOf('\n### ');
        const body = end > 0 ? blk.slice(0, end) : blk;
        const est = /\*\*Ước lượng\*\* \| \*\*([\d.,]+)\s*ngày/.exec(body);
        const own = /\*\*Owner\*\* \| `([^`]+)`/.exec(body);
        const dod = /\*\*DoD\*\* \| (.+)$/m.exec(body);
        wp.set(m[1], { id: m[1], title: m[2].trim(), days: est ? Number(est[1].replace(',', '.')) : null, owner: own ? own[1] : '—', dod: dod ? dod[1].trim() : '' });
    }
}

// 2) AC theo work package, từ packet
const acOf = new Map();
for (const f of readdirSync(join(ROOT, wbsDir, '01.packets', '01.bip')).filter((n) => n.endsWith('.md'))) {
    const s = read(`${wbsDir}/01.packets/01.bip/${f}`);
    const m = /^id: (?:BIP|FIP)-(\d+)_(\d+)/m.exec(s);
    if (!m) continue;
    const k = `${m[1]}.${m[2]}`;
    acOf.set(k, [...new Set([...(acOf.get(k) || []), ...(s.match(/AC-[A-Z]+-\d+-\d+/g) || [])])]);
}

// 3) US → feature
const cat = read('sdlc/06.analysis/01.business-analysis/06.eso-features.md');
const us2f = new Map();
for (const m of cat.matchAll(/^\| \*\*(F-\d{2})\*\* \| [^|]+\|[^|]+\|[^|]+\|[^|]+\| ([^|]+)\|/gm))
    for (const u of m[2].match(/US-[A-Z]+-\d+/g) || []) us2f.set(u, m[1]);

// 4) Epic key của mỗi feature
const epics = new Map();
const found = await call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO AND issuetype = Epic')}&fields=summary,labels&maxResults=100`);
for (const i of found.issues) { const f = (i.fields.labels || []).find((l) => /^f-\d\d$/.test(l)); if (f) epics.set(f.toUpperCase(), i.key); }

// 5) Issue đã có theo label wp-<id>
const have = new Map();
const ex = await call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO ORDER BY key')}&fields=labels&maxResults=300`);
for (const i of ex.issues) for (const l of i.fields.labels || []) if (l.startsWith('wp-')) have.set(l.slice(3), i.key);

const DAYS2SP = (d) => (d === null ? 3 : d <= 0.5 ? 1 : d <= 1 ? 2 : d <= 1.5 ? 3 : d <= 2 ? 5 : d <= 3 ? 8 : 13);
const plain = (t) => t.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
const code = (t) => '{{' + plain(t) + '}}';

const plan = [];
for (const x of [...wp.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    const acs = acOf.get(x.id) || [];
    let feature = null;
    if (acs.length) {
        const tally = new Map();
        for (const a of acs) { const p = a.split('-'); const f = us2f.get(`US-${p[1]}-${p[2]}`); if (f) tally.set(f, (tally.get(f) || 0) + 1); }
        feature = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
    plan.push({ ...x, acs, feature, kind: acs.length ? 'Story' : 'Task' });
}

const byKind = { Story: plan.filter((p) => p.kind === 'Story'), Task: plan.filter((p) => p.kind === 'Task') };
console.log(`DRY-RUN=${!apply} · WP: ${plan.length} → Story ${byKind.Story.length} (${byKind.Story.filter((p) => p.feature).length} có epic) · Task ${byKind.Task.length}`);
console.log(`đã có issue: ${have.size}\n`);

const subs4 = (parentPoints) => [
    ['tdd-unit', 'unit test', 2],
    ['tdd-impl', 'implement', parentPoints],
    ['tdd-coverage', 'coverage gate', 1],
    ['tdd-qc', 'scenario + RTM', 3],
];

let made = 0, skipped = 0, failed = 0;
for (const p of plan) {
    if (have.has(p.id)) { skipped++; continue; }
    const sp = DAYS2SP(p.days);
    const epic = p.feature ? epics.get(p.feature) : null;
    const label = `wp-${p.id}`;
    if (!apply) {
        console.log(`  ${p.kind === 'Story' ? '+' : '·'} ${p.id.padEnd(5)} ${p.kind.padEnd(5)} epic=${(epic || '—').padEnd(7)} sp=${sp} · ${plain(p.title).slice(0, 50)}`);
        continue;
    }
    const fields = {
        project: { key: 'ESO' }, issuetype: { name: p.kind },
        summary: `${p.id} — ${plain(p.title)}`,
        labels: [p.kind.toLowerCase(), label, ...(p.feature ? [p.feature.toLowerCase()] : []), 'needs-dor'],
        description: [
            'h3. Work package', `${code(p.id)} — ${plain(p.title)}`, '',
            'h3. Phân loại', p.kind === 'Story'
                ? `*Story* — packet §7 claim ${p.acs.length} AC: ${p.acs.map(code).join(' · ')}`
                : '*Task* — không AC nào claim work package này (chuẩn 07 §3: không AC ⇒ Task).', '',
            'h3. Ước lượng', `${p.days ?? '—'} ngày ⇒ *${sp}* SP. ${p.kind === 'Story' ? 'Điểm Story là *tổng* của 4 subtask (chuẩn 07 §10).' : 'Task không có subtask; điểm nhập tay.'}`, '',
            'h3. Owner', code(p.owner), '',
            'h3. DoD', p.dod || '*OPEN* — dictionary không có dòng DoD.', '',
            'h3. DoR', 'Chưa đo. Chạy {{jira-points-audit}} rồi kiểm packet §9 trước khi kéo vào sprint.',
        ].join('\n'),
    };
    if (epic && p.kind === 'Story') fields.parent = { key: epic };
    if (p.kind === 'Task') fields.customfield_10016 = sp;
    try {
        const r = await call('POST', '/rest/api/2/issue', { fields });
        made++;
        console.log(`  ✅ ${r.key} ${p.kind} ${p.id} sp=${sp}`);
        if (p.kind === 'Story') {
            let sum = 0;
            for (const [tag, what, pts] of subs4(sp)) {
                const sr = await call('POST', '/rest/api/2/issue', {
                    fields: {
                        project: { key: 'ESO' }, issuetype: { name: 'Subtask' }, parent: { key: r.key },
                        summary: `[${tag.startsWith('tdd-qc') ? 'qc' : 'be'}] ${p.id} — ${what}`,
                        labels: ['subtask', tag, label, ...(p.feature ? [p.feature.toLowerCase()] : [])],
                        description: `h3. Một bước nguyên tử\n${what} cho work package ${code(p.id)}.\n\nh3. Story Points\n${pts}`,
                        customfield_10016: pts,
                    },
                });
                sum += pts;
                console.log(`      ${sr.key} ${tag} ${pts}`);
            }
            await call('PUT', `/rest/api/2/issue/${r.key}`, { fields: { customfield_10016: sum } });
            console.log(`      = story ${sum} SP (roll-up)`);
        }
    } catch (e) {
        failed++;
        console.log(`  ⛔ ${p.id}: ${e.message}`);
    }
}
console.log(apply ? `\ntạo ${made} · bỏ qua ${skipped} · lỗi ${failed}` : `\n${plan.length - skipped} việc sẽ tạo — thêm --apply`);
