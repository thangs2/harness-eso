#!/usr/bin/env node
// Một nguồn duy nhất cho dictionary WBS: work package · AC · phụ thuộc · loại subtask.
//
// Vì sao có file này: `jira-create-backlog.mjs` và audit từng tự parse lại dictionary. Bản sao thứ hai
// đã đọc sai nguồn AC một lần (packet thay vì dictionary) và sinh 5 story thành Task. Một nguồn, không hai.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const WBS_DIR = 'sdlc/09.wbs';
export const FEATURES = 'sdlc/06.analysis/01.business-analysis/06.eso-features.md';

// Tám loại subtask — chuẩn 07 §11.1 (2026-11-03). `tdd-fe` / `tdd-e2e` KHÔNG nằm trong tám loại này:
// §11 gọi nửa `[fe]` là `tdd-fe` trong văn xuôi, còn bảng §11.1 đặt lane ở summary và loại là `tdd-impl`/`tdd-qc`.
export const SUBTASK_KINDS = ['tdd-impl', 'tdd-unit', 'tdd-coverage', 'tdd-qc', 'tdd-ba', 'tdd-perf', 'tdd-load', 'tdd-stress'];
export const DEFAULT_LANE = { 'tdd-impl': 'be', 'tdd-unit': 'be', 'tdd-coverage': 'be', 'tdd-qc': 'qc', 'tdd-ba': 'ba', 'tdd-perf': 'qc', 'tdd-load': 'be', 'tdd-stress': 'be' };
// Bốn loại luôn có (§11: story không UI; story có UI thêm hai nửa `[fe]`).
export const BASE_KINDS = ['tdd-unit', 'tdd-impl', 'tdd-coverage', 'tdd-qc'];

const WP_HEAD = /^### `(\d+\.\d+)` · (.+)$/gm;

/** Markdown (dictionary) → wiki markup (Jira). Trả về chuỗi KHÔNG còn `**` hay backtick. */
export function mdToWiki(src) {
    const codes = [];
    const bolds = [];
    let t = String(src ?? '').replace(/`([^`]+)`/g, (_, c) => `\u0000C${codes.push(c) - 1}\u0000`);
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, (_, c) => `\u0000B${bolds.push(`*_${c}_*`) - 1}\u0000`);
    t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => `\u0000B${bolds.push(`*${c}*`) - 1}\u0000`);
    t = t.replace(/\*([^*\n]+)\*/g, '_$1_');
    t = t.replace(/\u0000B(\d+)\u0000/g, (_, i) => bolds[Number(i)]);
    t = t.replace(/\u0000C(\d+)\u0000/g, (_, i) => `{{${codes[Number(i)]}}}`);
    return t.replace(/\\\|/g, '|').replace(/\s*\|\s*$/, '').replace(/[ \t]+/g, ' ').trim();
}

/** Text node ADF → nhiều text node, chuyển Markdown rò rỉ thành mark thật (§7). */
function splitTextNode(node) {
    const text = node.text ?? '';
    if (!/[`*]|\\\|/.test(text)) return [node];
    const marks = node.marks || [];
    const parts = [];
    const push = (t, extra = []) => {
        if (!t) return;
        const all = [...marks, ...extra].filter((m, i, a) => a.findIndex((y) => y.type === m.type) === i);
        // ĐO 2026-11-03 trên ESO-24: ADF TỪ CHỐI `code` + `strong` trên cùng một text node (400 INVALID_INPUT).
        // `code` thắng — monospace là thông tin, đậm là trang trí.
        const kept = all.some((m) => m.type === 'code') ? all.filter((m) => m.type !== 'strong' && m.type !== 'em') : all;
        parts.push(kept.length ? { type: 'text', text: t, marks: kept } : { type: 'text', text: t });
    };
    const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
        push(text.slice(last, m.index).replace(/\\\|/g, '|'));
        const tok = m[0];
        if (tok.startsWith('***')) push(tok.slice(3, -3), [{ type: 'strong' }, { type: 'em' }]);
        else if (tok.startsWith('**')) push(tok.slice(2, -2), [{ type: 'strong' }]);
        else if (tok.startsWith('`')) push(tok.slice(1, -1), [{ type: 'code' }]);
        else push(tok.slice(1, -1), [{ type: 'em' }]);
        last = m.index + tok.length;
    }
    push(text.slice(last).replace(/\\\|/g, '|'));
    return parts.length ? parts : [node];
}

/** Sửa ADF tại chỗ: Markdown rò rỉ trong text node → mark thật. Không đổi chữ, chỉ đổi định dạng. */
export function fixAdfMarkup(doc) {
    const walk = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'text') return splitTextNode(node);
        if (Array.isArray(node.content)) node.content = node.content.flatMap(walk);
        return node;
    };
    return walk(structuredClone(doc));
}

/** ADF → text (description đọc qua REST v3). */
export function adfText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return '@' + (node.attrs?.text || '?');
    const inner = (node.content || []).map(adfText).join('');
    if (node.type === 'heading') return '\n' + inner + '\n';
    if (node.type === 'paragraph' || node.type === 'codeBlock' || node.type === 'blockquote') return inner + '\n';
    if (node.type === 'listItem') return '- ' + inner.trim() + '\n';
    return inner;
}

/** Ô `| **Tên** | giá trị |` trong block của một work package. */
function cell(body, name) {
    const r = new RegExp(`^\\| \\*\\*${name}\\*\\* \\| (.*) \\|\\s*$`, 'm').exec(body);
    return r ? r[1].trim() : '';
}

function firstNumber(s) {
    const m = /-?\d+(?:[.,]\d+)?/.exec(s || '');
    return m ? Number(m[0].replace(',', '.')) : null;
}

/** `Phụ thuộc` → [{ wp: '3.4' } | { wp: null, label: 'W5b' }]. */
export function parseDeps(text) {
    const t = (text || '').trim();
    if (!t || t === '—' || /^—/.test(t)) return [];
    return t.split('·')
        .map((x) => x.replace(/\*\*/g, '').replace(/`/g, '').trim())
        .filter(Boolean)
        .map((x) => {
            const m = /^(\d+\.\d+)\b/.exec(x);
            if (m) return { wp: m[1], note: x.slice(m[1].length).replace(/^[\s(]+|[)\s]+$/g, '') };
            return { wp: null, label: x.split(/\s*\(/)[0].trim() };
        });
}

/** Toàn bộ work package của dictionary. Map<id, WP>. */
export function loadWps(root) {
    const files = readdirSync(join(root, WBS_DIR)).filter((n) => /deliverable-\d+(-split)?\.md$/.test(n)).sort();
    const wps = new Map();
    for (const f of files) {
        const s = readFileSync(join(root, WBS_DIR, f), 'utf8');
        const heads = [...s.matchAll(WP_HEAD)];
        heads.forEach((m, i) => {
            const start = m.index + m[0].length;
            const body = s.slice(start, i + 1 < heads.length ? heads[i + 1].index : s.length);
            const dodRaw = cell(body, 'DoD');
            const daysRaw = cell(body, 'Ước lượng');
            const acs = [...new Set(dodRaw.match(/AC-[A-Z]+-\d+-\d+/g) || [])];
            const deps = parseDeps(cell(body, 'Phụ thuộc'));
            const done = /đã tạo|xong/i.test(`${cell(body, 'Việc')} ${daysRaw}`) && (/\*\*0\*\*/.test(daysRaw) || /đã tạo/i.test(cell(body, 'Việc')));
            wps.set(m[1], {
                id: m[1], title: m[2].trim(), file: f,
                days: firstNumber(daysRaw),
                owner: cell(body, 'Owner').replace(/`/g, ''),
                dodRaw, dod: mdToWiki(dodRaw),
                deps, acs,
                ui: acs.some((a) => a.startsWith('AC-UI-')),
                nfr: /NFR-\d+/.test(body),
                out: /\bOUT\b/.test(body),
                done,
                kind: acs.length ? 'Story' : 'Task',
            });
        });
    }
    return wps;
}

/** US-<area>-<nn> → F-nn (feature catalog). */
export function loadUs2F(root) {
    const map = new Map();
    let s = '';
    try { s = readFileSync(join(root, FEATURES), 'utf8'); } catch { return map; }
    for (const m of s.matchAll(/^\| \*\*(F-\d{2})\*\* \| [^|]+\|[^|]+\|[^|]+\|[^|]+\| ([^|]+)\|/gm))
        for (const u of m[2].match(/US-[A-Z]+-\d+/g) || []) map.set(u, m[1]);
    return map;
}

/** Feature chiếm đa số AC của work package. */
export function featureOf(wp, us2f) {
    const tally = new Map();
    for (const a of wp.acs) {
        const p = a.split('-');
        const f = us2f.get(`US-${p[1]}-${p[2]}`);
        if (f) tally.set(f, (tally.get(f) || 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/**
 * Thứ tự mở khoá epic — `01.epic-map` §3 (bước 1…5, `by` = feature phải xong trước).
 * Trước 2026-11-03 bảng này nằm trong `jira-create-epics.mjs`; nay ở đây để cả tạo lẫn kiểm dùng chung.
 */
export const EPIC_STEPS = [
    { step: 1, ids: ['F-09'], by: [] },
    { step: 2, ids: ['F-05', 'F-13'], by: ['F-09'] },
    { step: 3, ids: ['F-01', 'F-02', 'F-03', 'F-04'], by: ['F-05'] },
    { step: 4, ids: ['F-06', 'F-07', 'F-08', 'F-10', 'F-15', 'F-16', 'F-14'], by: ['F-01'] },
    { step: 5, ids: ['F-11', 'F-12', 'F-17', 'F-18'], by: ['F-13'] },
    { step: 5, ids: ['F-19', 'F-20', 'F-21', 'F-22', 'F-23'], by: ['F-09'] },
];

/** Cặp epic phải có link "blocker CHẶN blocked" theo epic-map §3. */
export function planEpicLinks() {
    const out = [];
    const seen = new Set();
    for (const s of EPIC_STEPS) {
        for (const by of s.by) {
            for (const id of s.ids) {
                const key = `${by}>${id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ blocker: by, blocked: id, step: s.step, why: 'epic-map §3' });
            }
        }
    }
    return out;
}

/** Ngày → Story Point. `0 (xong)` = 0 SP, không phải 3. */
export function daysToSp(d) {
    if (d === null) return 3;
    if (d <= 0) return 0;
    if (d <= 0.5) return 1;
    if (d <= 1) return 2;
    if (d <= 1.5) return 3;
    if (d <= 2) return 5;
    if (d <= 3) return 8;
    return 13;
}

/**
 * Dictionary → kế hoạch ticket, đã tính đủ blocks/blockedBy/sp/feature.
 * Generator và bản vá đều dùng hàm này — hai bản sao kế hoạch là hai bản sao sẽ lệch.
 */
export function buildPlan(root) {
    const wps = loadWps(root);
    const us2f = loadUs2F(root);
    const blocks = new Map([...wps.keys()].map((k) => [k, []]));
    const links = planLinks(wps);
    for (const l of links) blocks.get(l.blocker)?.push(l.blocked);
    const plan = [...wps.values()].map((w) => ({
        ...w,
        sp: daysToSp(w.days),
        feature: featureOf(w, us2f),
        blocks: blocks.get(w.id) || [],
        blockedBy: w.deps.filter((d) => d.wp && wps.has(d.wp)).map((d) => d.wp),
        nonWpDeps: w.deps.filter((d) => !d.wp).map((d) => d.label),
    }));
    return { wps, us2f, links, plan };
}

/**
 * Description ticket — bốn quan hệ khai tường minh (07 §6.1: `none` phải nói ra).
 * `atomic`: Task ≤ 0,5 ngày mới được khai "không tách được".
 */
export function buildDescription(p, plainText) {
    const clean = plainText || ((t) => String(t ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim());
    const atomic = p.days !== null && p.days <= 0.5;
    const subs = p.kind === 'Story'
        ? subtaskPlan(p, p.sp).map((s) => `{{${s.kind}}}[${s.lane}]`).join(' · ')
        : `none — ${atomic ? 'WP nguyên tử: một lệnh verify, không tách được' : '⚠ CHƯA KHAI — Task > 0,5 ngày phải có ≥1 subtask hoặc lý do (DoR #1 đỏ)'}`;
    const lst = (a) => (a.length ? a.map((x) => `{{${x}}}`).join(' · ') : 'none — không có trong dictionary');
    return [
        'h3. Work package', `{{${p.id}}} — ${clean(p.title)}`, '',
        'h3. Phân loại',
        p.kind === 'Story'
            ? `*Story* — dictionary §DoD claim ${p.acs.length} AC: ${p.acs.map((a) => `{{${a}}}`).join(' · ')}`
            : `*Task* — không AC nào claim work package này (chuẩn 07 §3: không AC ⇒ Task).${p.out ? ' Dictionary ghi OUT có lý do — xem DoD.' : ''}`, '',
        'h3. Ước lượng',
        `${p.days === null ? '—' : String(p.days).replace('.', ',')} ngày ⇒ *${p.sp}* SP. ` +
        (p.kind === 'Story' ? 'Điểm Story là *tổng* của subtask (chuẩn 07 §10).'
            : `Điểm Task nhập tay — không có subtask (${atomic ? 'WP nguyên tử' : '⚠ cần tách hoặc khai lý do'}).`), '',
        'h3. Quan hệ',
        // Dùng bullet, KHÔNG dùng \n: Jira chỉ đôi lúc đổi newline thành hardBreak — đo trên ESO-34
        // (hai dòng "subtasks"/"relates" dính thành một câu). Bullet thì luôn ra bulletList.
        `* subtasks: ${subs}`,
        '* relates: none — ngoài quan hệ chặn, chưa có quan hệ khác được khai',
        `* blocks: ${lst(p.blocks)}`,
        `* blockedBy: ${lst(p.blockedBy)}${p.nonWpDeps?.length ? ` · ngoài WBS: ${p.nonWpDeps.map((x) => `{{${x}}}`).join(' · ')}` : ''}`, '',
        'h3. Owner', `{{${p.owner || '—'}}}`, '',
        'h3. DoD', p.dod || '*OPEN* — dictionary không có dòng DoD.', '',
        'h3. Verify', '*OPEN* — người viết: QC chứng minh DoD bằng gì (lệnh · test · bằng chứng)? (DoR #5)',
    ].join('\n');
}

/**
 * Payload cho POST /issueLink của một link "blocker CHẶN blocked".
 *
 * ĐO 2026-11-03 (link tạm ESO-34 → ESO-37 rồi xoá): payload `{inwardIssue: blocker, outwardIssue: blocked}`
 * ⇒ JQL `issue in linkedIssues("blocker","blocks")` trả `blocked`. Tên hai field **ngược** với câu
 * "outward = blocks" trong tài liệu Jira — và `jira-create.mjs` đã tin câu đó nên tạo link ngược chiều.
 * Mọi chỗ tạo link phải đi qua hàm này, đừng tự viết lại payload.
 */
export function linkPayload(blocker, blocked) {
    return { type: { name: 'Blocks' }, inwardIssue: { key: blocker }, outwardIssue: { key: blocked } };
}

/** Đồ thị phụ thuộc → danh sách link cần có. `blocker` chặn `blocked`. */
export function planLinks(wps) {
    const links = [];
    const seen = new Set();
    for (const w of wps.values()) {
        for (const d of w.deps) {
            if (!d.wp || !wps.has(d.wp)) continue;
            const key = `${d.wp}>${w.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ blocker: d.wp, blocked: w.id, why: 'dictionary Phụ thuộc' });
        }
    }
    return links;
}

/** Danh sách subtask đúng chuẩn 07 §11 cho một Story. */
export function subtaskPlan(wp, storyPoints) {
    // Điểm từng loại: unit 2 · coverage 1 · qc 3 (17 §2). Nửa `[fe]` chưa có chuẩn điểm —
    // lấy 5/2 theo dữ liệu đã tạo (ESO-282…291) thay vì bịa thêm một con số thứ ba.
    const out = [
        { kind: 'tdd-unit', lane: 'be', title: 'unit tests', points: 2 },
        { kind: 'tdd-impl', lane: 'be', title: 'Implement (DEV)', points: storyPoints },
        { kind: 'tdd-coverage', lane: 'be', title: 'coverage gate', points: 1 },
        { kind: 'tdd-qc', lane: 'qc', title: 'Scenarios + RTM', points: 3 },
    ];
    if (wp.ui) {
        out.push({ kind: 'tdd-impl', lane: 'fe', title: 'Implement giao diện (FE)', points: 5 });
        out.push({ kind: 'tdd-qc', lane: 'fe', title: 'E2E một luồng', points: 2 });
    }
    if (wp.nfr) {
        out.push({ kind: 'tdd-perf', lane: 'qc', title: 'đo NFR', points: 5 });
        out.push({ kind: 'tdd-load', lane: 'be', title: 'load test', points: 3 });
        out.push({ kind: 'tdd-stress', lane: 'be', title: 'stress test', points: 3 });
    }
    return out;
}

/** Lane của một subtask đã có: ưu tiên label, rồi tiền tố `[xx]` ở summary. */
export function laneOf(labels, summary) {
    const fromLabel = (labels || []).find((l) => /^\[?(be|fe|mo|qc|ba)\]?$/.test(l));
    if (fromLabel) return fromLabel.replace(/[[\]]/g, '');
    const m = /^\[(be|fe|mo|qc|ba)\]/.exec(summary || '');
    return m ? m[1] : null;
}
