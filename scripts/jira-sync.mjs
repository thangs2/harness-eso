// Sync `sdlc/` → Jira theo đúng một thứ tự, và **chứng minh** nó khớp.
//
//   node scripts/jira-sync.mjs                 # chỉ đọc: in ra sẽ đổi gì, exit 1 nếu còn việc chờ
//   node scripts/jira-sync.mjs --apply         # ghi theo thứ tự, rồi kiểm lại bằng bước chỉ-đọc
//   node scripts/jira-sync.mjs --only=repair,audit
//   node scripts/jira-sync.mjs --apply --json  # máy đọc
//
// Vì sao có wrapper: "sync" từng là năm lệnh phải nhớ đúng thứ tự, và **không gì canh idempotent**.
// Chạy hai lần phải ra cùng trạng thái — `qc/jira-sync.test.mjs` ghim phần logic, và `--apply` tự
// kiểm lại bằng `audit`/`points-audit` thay vì tin vào việc "đã ghi".
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, STEPS, formatReport, missingEnv, parseArgs, parseStep, summarize } from './lib/jira-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));

if (args.help) {
    console.log(`jira-sync — sdlc/ → Jira, idempotent

  node scripts/jira-sync.mjs [--apply] [--only=a,b] [--json]

Bước ghi (theo thứ tự): ${STEPS.map((s) => s.key).join(' → ')}
Bước đọc (luôn chạy sau cùng): ${CHECKS.map((s) => s.key).join(' → ')}
Không có --apply ⇒ chỉ đọc, và exit 1 nếu còn việc chờ.`);
    process.exit(0);
}

const missing = missingEnv();
if (missing.length) {
    console.error(`✗ thiếu biến môi trường: ${missing.join(', ')} — đặt trong .env rồi chạy lại`);
    process.exit(2);
}

const run = (step, apply) => {
    const extra = apply && step.applyArg ? [step.applyArg] : [];
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', step.file), ...extra], {
        cwd: ROOT,
        encoding: 'utf8',
        env: process.env,
    });
    const stdout = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    let parsed;
    try {
        parsed = parseStep(step.key, stdout);
    } catch (e) {
        parsed = { pending: null, hard: null, warn: null, unparsed: true, error: e.message };
    }
    return { key: step.key, what: step.what, status: r.status ?? 1, parsed, stdout };
};

const wanted = (s) => !args.only || args.only.includes(s.key);
const results = [];

// 1. Ghi (hoặc chỉ đọc từng bước) theo thứ tự.
for (const step of STEPS) if (wanted(step)) results.push(run(step, args.apply));

// 2. Luôn kết thúc bằng bước đo — kể cả khi vừa ghi.
for (const step of CHECKS) if (wanted(step)) results.push(run(step, false));

const summary = summarize(results);
if (args.json) {
    console.log(JSON.stringify({ applied: args.apply, ...summary, steps: results.map(({ key, status, parsed }) => ({ key, status, parsed })) }, null, 2));
} else {
    console.log(`DRY-RUN=${!args.apply} · bước: ${results.length}`);
    console.log('');
    console.log(formatReport(results, { applied: args.apply }));
    if (args.apply) {
        const failedSteps = results.filter((r) => r.status !== 0);
        for (const f of failedSteps) console.log(`\n--- ${f.key} (exit ${f.status}) ---\n${f.stdout.trim().split('\n').slice(-6).join('\n')}`);
    }
}

process.exit(summary.ok ? 0 : 1);
