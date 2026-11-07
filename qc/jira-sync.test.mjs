import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS, STEPS, formatReport, missingEnv, parseArgs, parseStep, summarize } from '../scripts/lib/jira-sync.mjs';

// X39 — "sync" phải là một **thứ tự cố định** và phải **idempotent**: chạy lần hai không đổi gì.
//
// Lỗi đã sinh ra nó: sync sdlc → Jira sống như năm lệnh phải nhớ đúng thứ tự trong đầu người vận hành.
// Không có file, không có test, và không có gì nói "chạy hai lần thì sao". Một quy trình như vậy
// truyền qua transcript, và transcript thì không kiểm được.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = readFileSync(join(ROOT, 'scripts/jira-sync.mjs'), 'utf8');

// stdout thật, chép nguyên từ lần chạy 2026-11-07 (đã sạch) và một bản có việc chờ.
const CLEAN = {
    backlog: 'DRY-RUN=true · WP 72 → bỏ 0 đã xong · Story 62 · Task 10\n\n0 việc sẽ tạo · bỏ qua 72 · lỗi 0',
    repair: 'issue: 436 · WP ticket: 72 · DRY-RUN=true\n\n① description cần viết lại: 0\n①b markup rò rỉ cần sửa tại chỗ: 0\n② link thiếu: 0 · link ngược chiều: 0\n②b link epic–epic: thiếu 0 · ngược chiều 0 · ngoài epic-map 1\n③ subtask thiếu label wp-*: 0\n④ ticket đã xong mà còn mở: 0',
    points: '0 epic cần cập nhật — thêm --apply',
    'points-audit': 'issue: 436 · Epic · Story · Subtask · Task · Bug\n\nThiếu điểm: 0\n\nNgoài Fibonacci: 0\n\nRoll-up lệch: 0',
    audit: '0 nhóm vi phạm · 0 mục (0 hard · 0 warn)\n\nchi tiết: .harness/jira/audit.json',
};
// `--apply` in câu khác dry-run cho cùng một bước — đây là ca đã làm wrapper tự báo lỗi.
const APPLY = {
    backlog: 'link: cần tạo 0 · đã đúng 74 · ⚠ ngược chiều 0\n  tạo 0/0 link\n\ntạo 0 issue · bỏ qua 72 · lỗi 0',
    points: '0 epic cần cập nhật',
};
const DIRTY = {
    backlog: '10 việc sẽ tạo · bỏ qua 62 · lỗi 0',
    repair: '① description cần viết lại: 10\n①b markup rò rỉ cần sửa tại chỗ: 0\n② link thiếu: 3 · link ngược chiều: 1\n③ subtask thiếu label wp-*: 2\n④ ticket đã xong mà còn mở: 1',
    points: '4 epic cần cập nhật — thêm --apply',
    'points-audit': 'Thiếu điểm: 2\n\nNgoài Fibonacci: 1\n\nRoll-up lệch: 3',
    audit: '4 nhóm vi phạm · 9 mục (6 hard · 3 warn)',
};
const ALL = [...STEPS, ...CHECKS];
const run = (table) => ALL.map((s) => ({ key: s.key, what: s.what, status: 0, parsed: parseStep(s.key, table[s.key]) }));

test('X39: thứ tự là tạo → sửa → điểm, rồi mới đo bằng hai bước chỉ-đọc', () => {
    assert.deepEqual(STEPS.map((s) => s.key), ['backlog', 'repair', 'points']);
    assert.deepEqual(CHECKS.map((s) => s.key), ['points-audit', 'audit']);
    // Bước đo phải **không** có cờ ghi: đo mà ghi được thì "kiểm lại" không còn nghĩa.
    for (const c of CHECKS) assert.equal(c.applyArg, undefined, `${c.key} không được nhận --apply`);
    for (const s of STEPS) assert.equal(s.applyArg, '--apply', `${s.key} phải nhận --apply`);
});

test('X39: đọc đúng stdout thật của từng bước', () => {
    assert.equal(parseStep('backlog', CLEAN.backlog).pending, 0);
    assert.equal(parseStep('repair', CLEAN.repair).pending, 0);
    assert.equal(parseStep('points', CLEAN.points).pending, 0);
    assert.equal(parseStep('points-audit', CLEAN['points-audit']).hard, 0);
    const a = parseStep('audit', CLEAN.audit);
    assert.deepEqual([a.hard, a.warn], [0, 0]);

    assert.equal(parseStep('backlog', DIRTY.backlog).pending, 10);
    assert.equal(parseStep('repair', DIRTY.repair).pending, 10 + 3 + 1 + 2 + 1);
    assert.equal(parseStep('points', DIRTY.points).pending, 4);
    assert.equal(parseStep('points-audit', DIRTY['points-audit']).hard, 2 + 1 + 3);
    const d = parseStep('audit', DIRTY.audit);
    assert.deepEqual([d.hard, d.warn], [6, 3]);
});

test('X39: đọc được cả câu tổng kết của --apply, không chỉ của dry-run', () => {
    assert.equal(parseStep('backlog', APPLY.backlog).pending, 0);
    assert.equal(parseStep('points', APPLY.points).pending, 0);
    assert.equal(parseStep('backlog', 'tạo 3 issue · bỏ qua 69 · lỗi 0').pending, 3);
});

test('X39: bước đổi định dạng in ⇒ KHÔNG ĐỌC ĐƯỢC, không được coi là 0', () => {
    for (const s of ALL) {
        const r = parseStep(s.key, 'ok\n');
        assert.equal(r.unparsed, true, `${s.key}: mẫu không khớp mà vẫn coi như sạch`);
        // Bước ghi đếm `pending`; bước đo đếm `hard`. Cả hai đều phải null, không được là 0.
        const counted = STEPS.some((w) => w.key === s.key) ? 'pending' : 'hard';
        assert.equal(r[counted], null, `${s.key}: ${counted} phải là null khi không đọc được`);
    }
    const s = summarize(ALL.map((x) => ({ key: x.key, what: x.what, status: 0, parsed: parseStep(x.key, 'ok') })));
    assert.equal(s.ok, false, 'một bước không đọc được thì không thể kết luận "đang khớp"');
    assert.equal(s.unparsed.length, ALL.length);
});

test('X39: idempotent — chạy lần hai trên trạng thái đã sync phải ra 0 việc, 0 vi phạm', () => {
    const first = summarize(run(CLEAN));
    const second = summarize(run(CLEAN));
    assert.deepEqual({ pending: first.pending, hard: first.hard }, { pending: 0, hard: 0 });
    assert.deepEqual(second, first, 'lần hai phải giống hệt lần một — đó là định nghĩa "đã sync"');
    assert.equal(first.ok, true);
});

test('X39: còn việc chờ hoặc còn hard ⇒ kết luận chưa khớp, exit khác 0', () => {
    const s = summarize(run(DIRTY));
    assert.equal(s.ok, false);
    assert.equal(s.pending, 10 + 17 + 4);
    assert.equal(s.hard, 6 + 6);
    assert.match(formatReport(run(DIRTY)), /✗ chưa khớp/);
    assert.match(formatReport(run(CLEAN)), /✔ đang khớp/);
});

test('X39: mặc định là chỉ-đọc; cờ lạ là lỗi, không bỏ qua', () => {
    assert.equal(parseArgs([]).apply, false, 'không có --apply thì không được ghi');
    assert.equal(parseArgs(['--apply']).apply, true);
    assert.equal(parseArgs(['--only=repair,audit']).only.join(','), 'repair,audit');
    assert.throws(() => parseArgs(['--applyy']), /cờ lạ/);
    assert.throws(() => parseArgs(['--only=khong-co']), /--only lạ/);
});

test('X39: thiếu biến môi trường thì nói tên biến, không để lỗi 401', () => {
    assert.deepEqual(missingEnv({}), ['JIRA_BASE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN']);
    assert.deepEqual(missingEnv({ JIRA_BASE_URL: 'x', JIRA_USER_EMAIL: 'y', JIRA_API_TOKEN: 'z' }), []);
});

test('X39: CLI chỉ ghi khi có --apply, và luôn chạy bước đo sau cùng', () => {
    assert.match(cli, /apply && step\.applyArg/, 'CLI phải ràng buộc --apply với bước ghi');
    assert.match(cli, /for \(const step of CHECKS\)/, 'bước đo phải chạy sau các bước ghi');
    assert.match(cli, /process\.exit\(summary\.ok \? 0 : 1\)/, 'exit code phải mang nghĩa "khớp / chưa khớp"');
});
