import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWps, loadUs2F, parseDeps, planLinks, subtaskPlan, mdToWiki, laneOf, adfText, SUBTASK_KINDS } from '../scripts/lib/eso-wbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wps = loadWps(ROOT);

test('dictionary: 65 work package, id + cột DoD/Ước lượng parse được', () => {
    assert.equal(wps.size, 65);
    const w = wps.get('1.1');
    assert.equal(w.title, 'Luật SLP cho repo này');
    assert.equal(w.days, 0.5);
    assert.equal(w.kind, 'Task');
    assert.match(w.dod, /allowed_files/);
});

test('dictionary: `0 (xong)` là đã xong, không phải 3 SP', () => {
    const w = wps.get('1.6');
    assert.equal(w.days, 0);
    assert.equal(w.done, true);
});

test('mdToWiki: không còn Markdown trên ticket (chuẩn 07 §7)', () => {
    for (const w of wps.values()) {
        assert.doesNotMatch(w.dod, /`/, `${w.id} còn backtick`);
        assert.doesNotMatch(w.dod, /\*\*/, `${w.id} còn **`);
        assert.doesNotMatch(w.dod, /\\\|/, `${w.id} còn \\|`);
    }
    assert.equal(mdToWiki('**đậm** và `code`'), '*đậm* và {{code}}');
    assert.equal(mdToWiki('***cả hai***'), '*_cả hai_*');
});

test('parseDeps: bỏ ghi chú, giữ id, tách được ký hiệu ngoài WBS', () => {
    assert.deepEqual(parseDeps('**3.4** (cần record để hiện) · **4.4**').map((d) => d.wp), ['3.4', '4.4']);
    assert.deepEqual(parseDeps('—'), []);
    assert.deepEqual(parseDeps('**7.1** · **W5b** (cần `config:save`)').map((d) => d.wp), ['7.1', null]);
});

test('planLinks: chiều là "cái được phụ thuộc CHẶN cái phụ thuộc"', () => {
    const links = planLinks(wps);
    const has = (blocker, blocked) => links.some((l) => l.blocker === blocker && l.blocked === blocked);
    assert.ok(has('1.1', '1.2'), '1.2 phụ thuộc 1.1 ⇒ 1.1 chặn 1.2');
    assert.ok(has('1.1', '1.3'), '1.3 phụ thuộc 1.1');
    assert.ok(has('7.1', '7.2'), '7.2 phụ thuộc 7.1 ⇒ 7.1 chặn 7.2, KHÔNG ngược');
    assert.ok(!has('7.2', '7.1'), 'link ngược chiều là lỗi đã đo trên Jira');
    assert.ok(has('3.4', '7.1') && has('4.4', '7.1'), '7.1 phụ thuộc 3.4 · 4.4');
    assert.ok(has('3.1', '8.1') && has('8.1', '8.2'), '8.1 phụ thuộc 3.1, và 8.2 phụ thuộc 8.1');
    assert.equal(new Set(links.map((l) => `${l.blocker}>${l.blocked}`)).size, links.length, 'không link trùng');
});

test('subtaskPlan: 4 loại cơ bản, story có UI thêm nửa [fe], có NFR thêm perf/load/stress', () => {
    const plain = subtaskPlan({ ui: false, nfr: false }, 5);
    assert.deepEqual(plain.map((s) => `${s.kind}[${s.lane}]`), ['tdd-unit[be]', 'tdd-impl[be]', 'tdd-coverage[be]', 'tdd-qc[qc]']);
    const ui = subtaskPlan({ ui: true, nfr: false }, 5);
    assert.deepEqual(ui.map((s) => s.lane), ['be', 'be', 'be', 'qc', 'fe', 'fe']);
    const nfr = subtaskPlan({ ui: false, nfr: true }, 3);
    assert.deepEqual(nfr.slice(4).map((s) => s.kind), ['tdd-perf', 'tdd-load', 'tdd-stress']);
    for (const s of [...plain, ...ui, ...nfr]) assert.ok(SUBTASK_KINDS.includes(s.kind));
});

test('laneOf: đọc tiền tố vai từ summary (chuẩn 07 §11)', () => {
    assert.equal(laneOf([], '[qc] 7.2 — Scenarios + RTM'), 'qc');
    assert.equal(laneOf([], '[fe] 7.2 — E2E một luồng'), 'fe');
    assert.equal(laneOf(['subtask', 'tdd-impl'], 'impl không có tiền tố'), null);
});

test('feature: story UI không map được US ⇒ không epic (ghi nhận, không tự bịa)', () => {
    const us2f = loadUs2F(ROOT);
    assert.equal(us2f.size > 0, true);
    assert.equal(us2f.has('US-UI-01'), false);
});

test('fixAdfMarkup: Markdown rò rỉ trong text node thành mark thật, chữ không đổi', async () => {
    const { fixAdfMarkup } = await import('../scripts/lib/eso-wbs.mjs');
    const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dùng `F-09` và **đậm**' }] }] };
    const out = fixAdfMarkup(doc);
    const nodes = out.content[0].content;
    assert.equal(nodes.map((n) => n.text).join(''), 'dùng F-09 và đậm');
    assert.deepEqual(nodes.find((n) => n.text === 'F-09').marks, [{ type: 'code' }]);
    assert.deepEqual(nodes.find((n) => n.text === 'đậm').marks, [{ type: 'strong' }]);
    assert.equal(adfText(out), 'dùng F-09 và đậm\n');
    // ADF từ chối `code` + `strong` cùng node (400 INVALID_INPUT, đo trên ESO-24) ⇒ code thắng.
    const both = fixAdfMarkup({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '`x`', marks: [{ type: 'strong' }] }] }] });
    assert.deepEqual(both.content[0].content[0].marks, [{ type: 'code' }]);
});

test('linkPayload: field nào là cái chặn — đo trên Jira 2026-11-03, không theo docs', async () => {
    const { linkPayload } = await import('../scripts/lib/eso-wbs.mjs');
    const p = linkPayload('ESO-34', 'ESO-35');
    assert.equal(p.type.name, 'Blocks');
    assert.equal(p.inwardIssue.key, 'ESO-34', 'inwardIssue = cái chặn (payload, không phải cách Jira trả về)');
    assert.equal(p.outwardIssue.key, 'ESO-35');
});
