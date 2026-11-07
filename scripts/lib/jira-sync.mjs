// Logic của `jira-sync` — tách khỏi CLI để test được mà không cần Jira.
//
// Vì sao có file này: trước 2026-11-07, "sync sdlc → Jira" là **năm lệnh phải nhớ đúng thứ tự**, và
// không có gì canh rằng nó **idempotent** — chạy hai lần phải ra cùng một trạng thái. Một quy trình
// chỉ sống trong trí nhớ người vận hành thì lần sau người khác đọc transcript sẽ chạy sai thứ tự.

/** Thứ tự là phần của định nghĩa: tạo trước, sửa sau, rồi mới đo. */
export const STEPS = [
    { key: 'backlog', file: 'jira-create-backlog.mjs', what: 'tạo Story/Task còn thiếu', applyArg: '--apply' },
    { key: 'repair', file: 'jira-repair.mjs', what: 'description · link · label', applyArg: '--apply' },
    { key: 'points', file: 'jira-points-rollup.mjs', what: 'điểm Epic = tổng con', applyArg: '--apply' },
];

/** Chỉ đọc — chạy cả sau khi ghi, vì "đã ghi" không tự chứng minh "đã khớp". */
export const CHECKS = [
    { key: 'points-audit', file: 'jira-points-audit.mjs', what: 'điểm theo §10' },
    { key: 'audit', file: 'jira-audit.mjs', what: 'toàn bộ chuẩn 07' },
];

const num = (re, text) => {
    const m = re.exec(text ?? '');
    return m ? Number(m[1]) : null;
};

/**
 * Đọc stdout của từng bước thành con số — không đoán, không đếm dòng.
 * Trả `null` khi mẫu không khớp: một bước đổi định dạng in mà không ai cập nhật đây
 * thì phải **báo**, không được im lặng coi là 0 việc.
 */
export function parseStep(key, stdout) {
    if (key === 'backlog') {
        // Dry-run và --apply in **hai câu khác nhau**: `N việc sẽ tạo` và `tạo N issue`.
        // Chỉ đọc một dạng là wrapper tự báo "không đọc được" đúng lúc nó vừa ghi — đã xảy ra.
        const pending = num(/(\d+) việc sẽ tạo/, stdout) ?? num(/tạo (\d+) issue/, stdout);
        return { pending, hard: 0, warn: 0, unparsed: pending === null };
    }
    if (key === 'repair') {
        const parts = [
            num(/① description cần viết lại: (\d+)/, stdout),
            num(/①b markup rò rỉ cần sửa tại chỗ: (\d+)/, stdout),
            (() => { const m = /② link thiếu: (\d+) · link ngược chiều: (\d+)/.exec(stdout ?? ''); return m ? Number(m[1]) + Number(m[2]) : null; })(),
            num(/③ subtask thiếu label wp-\*: (\d+)/, stdout),
            num(/④ ticket đã xong mà còn mở: (\d+)/, stdout),
        ];
        const unparsed = parts.some((p) => p === null);
        return { pending: unparsed ? null : parts.reduce((a, b) => a + b, 0), hard: 0, warn: 0, unparsed };
    }
    if (key === 'points') {
        const pending = num(/(\d+) epic cần cập nhật/, stdout); // giống nhau ở cả hai chế độ
        return { pending, hard: 0, warn: 0, unparsed: pending === null };
    }
    if (key === 'points-audit') {
        const parts = [
            num(/Thiếu điểm: (\d+)/, stdout),
            num(/Ngoài Fibonacci: (\d+)/, stdout),
            num(/Roll-up lệch: (\d+)/, stdout),
        ];
        const unparsed = parts.some((p) => p === null);
        return { pending: 0, hard: unparsed ? null : parts.reduce((a, b) => a + b, 0), warn: 0, unparsed };
    }
    if (key === 'audit') {
        const m = /(\d+) nhóm vi phạm · (\d+) mục \((\d+) hard · (\d+) warn\)/.exec(stdout ?? '');
        return m
            ? { pending: 0, hard: Number(m[3]), warn: Number(m[4]), unparsed: false }
            : { pending: null, hard: null, warn: null, unparsed: true };
    }
    throw new Error(`bước lạ: ${key}`);
}

/** Gộp kết quả: `ok` chỉ khi không có việc chờ, không có vi phạm, và **không bước nào không đọc được**. */
export function summarize(results) {
    const unparsed = results.filter((r) => r.parsed?.unparsed).map((r) => r.key);
    const pending = results.reduce((a, r) => a + (r.parsed?.pending ?? 0), 0);
    const hard = results.reduce((a, r) => a + (r.parsed?.hard ?? 0), 0);
    const warn = results.reduce((a, r) => a + (r.parsed?.warn ?? 0), 0);
    const failed = results.filter((r) => r.status !== 0).map((r) => r.key);
    return { pending, hard, warn, unparsed, failed, ok: !pending && !hard && !unparsed.length && !failed.length };
}

export function formatReport(results, { applied = false } = {}) {
    const lines = [];
    for (const r of results) {
        const p = r.parsed ?? {};
        const bits = [];
        if (p.pending) bits.push(`${p.pending} chờ`);
        if (p.hard) bits.push(`${p.hard} hard`);
        if (p.warn) bits.push(`${p.warn} warn`);
        if (p.unparsed) bits.push('KHÔNG ĐỌC ĐƯỢC kết quả');
        if (r.status !== 0) bits.push(`exit ${r.status}`);
        lines.push(`${bits.length ? '…' : '✔'} ${r.key.padEnd(13)} ${r.what.padEnd(30)} ${bits.join(' · ') || 'khớp'}`);
    }
    const s = summarize(results);
    lines.push('');
    lines.push(
        s.ok
            ? `✔ ${applied ? 'đã ghi và kiểm lại' : 'đang khớp'}: không việc chờ, không vi phạm`
            : `✗ chưa khớp: ${s.pending} việc chờ · ${s.hard} hard · ${s.warn} warn · ${s.unparsed.length} bước không đọc được${s.failed.length ? ` · ${s.failed.length} bước lỗi` : ''}`,
    );
    return lines.join('\n');
}

/** Chỉ `--apply` mới ghi; mọi thứ khác là chỉ-đọc. Cờ lạ là lỗi, không bỏ qua. */
export function parseArgs(argv) {
    const out = { apply: false, only: null, json: false };
    for (const a of argv) {
        if (a === '--apply') out.apply = true;
        else if (a === '--json') out.json = true;
        else if (a.startsWith('--only=')) {
            out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
            const known = new Set([...STEPS, ...CHECKS].map((s) => s.key));
            for (const k of out.only) if (!known.has(k)) throw new Error(`--only lạ: ${k}`);
        } else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`cờ lạ: ${a}`);
    }
    return out;
}

/** Kiểm môi trường trước khi gọi mạng — thiếu biến thì nói tên biến, không để lỗi 401 khó hiểu. */
export function missingEnv(env = process.env) {
    return ['JIRA_BASE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !env[k]);
}
