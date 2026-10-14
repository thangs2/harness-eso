#!/usr/bin/env node
/**
 * Audit where the prompt tokens actually went, reading the observe DB that `harness-observe-server`
 * already fills from the `stop` hook.
 *
 * Why this exists: a "prompt" costs far more than one API call. The agent loop makes one model call
 * per step (Read, Shell, StrReplace, …) and every call re-sends the whole context, so the bill for
 * one prompt is `Σ(context size at each step)` — a product, not a sum. That is invisible in the
 * Observatory UI, which shows one number per request. This prints the breakdown that explains it:
 * calls per prompt, average context per call, and the cache-hit share.
 *
 * The observe server holds a write lock on the live DB, so this copies `harness.db` (+ `-wal`,
 * `-shm`) into a temp dir and queries the copy. Read-only by construction: never touches the
 * original.
 *
 * Usage
 *   node scripts/token-audit.mjs                      # newest project under ~/.harness/observe
 *   node scripts/token-audit.mjs --project x79
 *   node scripts/token-audit.mjs --db /path/harness.db --limit 25
 *   node scripts/token-audit.mjs --transcript ~/.cursor/projects/<p>/agent-transcripts/<id>/<id>.jsonl
 *
 * Requires the `sqlite3` CLI (macOS/Linux ship it; Windows: `winget install SQLite.SQLite`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHARS_PER_TOKEN = 3.6; // rough, for the transcript mode only

function parseArgs(argv) {
    const out = { limit: 15, transcript: null, db: null, project: null };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--db') out.db = argv[++i];
        else if (a === '--project') out.project = argv[++i];
        else if (a === '--limit') out.limit = Number(argv[++i]);
        else if (a === '--transcript') out.transcript = argv[++i];
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function observeRoot() {
    return path.join(os.homedir(), '.harness', 'observe');
}

/** Every `harness.db` under ~/.harness/observe/<project>/, newest first. */
function candidates() {
    const root = observeRoot();
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root)
        .map((name) => path.join(root, name, 'harness.db'))
        .filter((p) => fs.existsSync(p))
        .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((x) => x.p);
}

function resolveDb(args) {
    if (args.db) return args.db;
    const all = candidates();
    if (!all.length) return null;
    if (args.project) {
        const hit = all.find((p) => path.basename(path.dirname(p)) === args.project);
        if (!hit) throw new Error(`no observe DB for project "${args.project}" under ${observeRoot()}`);
        return hit;
    }
    return all[0];
}

/**
 * Copy the DB triple beside the WAL into a scratch dir. The `-wal` file matters: the newest rows
 * (i.e. the prompt you are debugging) usually live there and are not yet in the main file.
 */
function snapshot(dbPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-token-audit-'));
    for (const suffix of ['', '-wal', '-shm']) {
        const src = `${dbPath}${suffix}`;
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, path.basename(dbPath) + suffix));
    }
    return path.join(dir, path.basename(dbPath));
}

function q(db, sql) {
    const res = spawnSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(String(res.stderr || '').trim() || `sqlite3 exited ${res.status}`);
    const text = String(res.stdout || '').trim();
    return text ? JSON.parse(text) : [];
}

const num = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => num(v).toLocaleString('en-US');
const pct = (a, b) => (num(b) ? `${((num(a) / num(b)) * 100).toFixed(1)}%` : '—');
const clip = (s, n) => {
    const one = String(s ?? '').replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function table(rows, cols) {
    if (!rows.length) {
        console.log('  (no rows)');
        return;
    }
    const cells = rows.map((r) => cols.map((c) => String(c.get(r) ?? '—')));
    const widths = cols.map((c, i) => Math.max(c.head.length, ...cells.map((row) => row[i].length)));
    const line = (vals) => `  ${vals.map((v, i) => (cols[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ')}`;
    console.log(line(cols.map((c) => c.head)));
    console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
    for (const row of cells) console.log(line(row));
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function report(db, limit) {
    const totals = q(
        db,
        `select count(*) reqs, sum(input_tokens) in_tok, sum(output_tokens) out_tok,
                sum(cache_read_tokens) cache_read, sum(call_count) calls, sum(tool_count) tools
         from request`,
    )[0] ?? {};

    console.log(`db: ${db}`);
    console.log(`prompts: ${fmt(totals.reqs)}   model calls: ${fmt(totals.calls)}   tool calls: ${fmt(totals.tools)}`);

    section('Tokens recorded (harness `stop` hook)');
    if (!num(totals.in_tok)) {
        console.log('  No token columns populated. Either the observe server has not ingested this');
        console.log('  project yet, or every prompt ran on a model Cursor reports no usage for.');
    } else {
        console.log(`  input: ${fmt(totals.in_tok)}  output: ${fmt(totals.out_tok)}`);
        console.log(
            `  cache read: ${fmt(totals.cache_read)} of input (${pct(totals.cache_read, totals.in_tok)}) ` +
                '— the rest is billed at full input price',
        );
    }

    section('Per model');
    table(
        q(
            db,
            `select model_id, count(*) reqs, sum(input_tokens) in_tok, sum(call_count) calls,
                    round(1.0*sum(input_tokens)/nullif(sum(call_count),0)) avg_ctx_per_call
             from request where input_tokens is not null
             group by model_id order by in_tok desc`,
        ),
        [
            { head: 'model', get: (r) => r.model_id, right: false },
            { head: 'prompts', get: (r) => fmt(r.reqs), right: true },
            { head: 'input_tokens', get: (r) => fmt(r.in_tok), right: true },
            { head: 'calls', get: (r) => fmt(r.calls), right: true },
            { head: 'avg ctx/call', get: (r) => fmt(r.avg_ctx_per_call), right: true },
        ],
    );

    section(`Top ${limit} prompts by input tokens (cost driver)`);
    table(
        q(
            db,
            `select input_tokens, output_tokens, call_count, tool_count,
                    round(1.0*input_tokens/nullif(call_count,0)) avg_ctx, user_query
             from request where input_tokens is not null order by input_tokens desc limit ${Number(limit) || 15}`,
        ),
        [
            { head: 'input_tok', get: (r) => fmt(r.input_tokens), right: true },
            { head: 'out_tok', get: (r) => fmt(r.output_tokens), right: true },
            { head: 'calls', get: (r) => fmt(r.call_count), right: true },
            { head: 'tools', get: (r) => fmt(r.tool_count), right: true },
            { head: 'ctx/call', get: (r) => fmt(r.avg_ctx), right: true },
            { head: 'prompt', get: (r) => clip(r.user_query, 56), right: false },
        ],
    );

    section('Calls per prompt — the multiplier');
    table(
        q(
            db,
            `select case when call_count = 0 then '0'
                         when call_count <= 3 then '1-3'
                         when call_count <= 6 then '4-6'
                         when call_count <= 10 then '7-10'
                         when call_count <= 20 then '11-20'
                         else '21+' end bucket,
                    count(*) reqs, sum(call_count) calls, min(call_count) lo
             from request group by bucket order by lo`,
        ),
        [
            { head: 'calls/prompt', get: (r) => r.bucket, right: false },
            { head: 'prompts', get: (r) => fmt(r.reqs), right: true },
            { head: 'model calls', get: (r) => fmt(r.calls), right: true },
        ],
    );
    console.log('  Every call re-sends the whole context, so the "21+" bucket pays for the session.');

    const unknown = q(
        db,
        `select model_id, count(*) n, max(hook_at) last_at
         from request_stop where input_tokens is null group by model_id`,
    );
    if (unknown.length) {
        section('Models with no usage reported (audit blind spot)');
        table(unknown, [
            { head: 'model', get: (r) => r.model_id || '(null)', right: false },
            { head: 'stops', get: (r) => fmt(r.n), right: true },
            { head: 'last seen', get: (r) => clip(r.last_at, 24), right: false },
        ]);
        console.log('  Cursor reports usage only for its own models. For a custom (own-key) model the');
        console.log('  numbers are absent here — measure them with scripts/deepseek-usage-proxy.mjs.');
    }
}

// ---------------------------------------------------------------------------
// Transcript mode — counts the multiplier (model calls and their tool mix) from the
// raw agent transcript. This is the half that survives even when Cursor reports no
// usage: the loop structure is always there, only the token columns are missing.
//
// Caveat that must stay visible: the harness itself rewrites these transcripts
// (`qc/transcript-rewrite.test.mjs`), and tool *outputs* come back as `[REDACTED]`.
// So any byte count here is assistant-side only — a lower bound on the context that
// was actually re-sent. Token truth lives in the observe DB; use `--db` for that.
// ---------------------------------------------------------------------------
function transcriptReport(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let calls = 0;
    let turns = 0;
    let redacted = 0;
    let assistantChars = 0;
    const tools = new Map();
    const perTurn = [];

    for (const line of lines) {
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.type === 'turn_ended') {
            turns += 1;
            perTurn.push(calls);
            calls = 0;
            continue;
        }
        if (rec.role !== 'assistant') continue;
        calls += 1;
        const content = rec.message?.content ?? [];
        assistantChars += JSON.stringify(content).length;
        for (const c of content) {
            if (c?.type === 'tool_use') tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
            if (c?.type === 'text' && String(c.text ?? '').includes('[REDACTED]')) redacted += 1;
        }
    }
    const tok = (c) => Math.round(c / CHARS_PER_TOKEN);
    const totalTools = [...tools.values()].reduce((a, b) => a + b, 0);

    console.log(`transcript: ${file}`);
    console.log(`model calls: ${fmt(calls + perTurn.reduce((a, b) => a + b, 0))}   tool calls: ${fmt(totalTools)}`);
    console.log(`turns (turn_ended): ${fmt(turns)}   redacted assistant texts: ${fmt(redacted)}`);
    console.log(
        `assistant-side content: ${fmt(assistantChars)} chars (~${fmt(tok(assistantChars))} tok) — ` +
            'lower bound, tool outputs are redacted',
    );

    section('Tool calls (each one costs a full context re-send)');
    table(
        [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, n })),
        [
            { head: 'tool', get: (r) => r.name, right: false },
            { head: 'calls', get: (r) => fmt(r.n), right: true },
        ],
    );

    if (turns) {
        section('Model calls per turn');
        table(
            perTurn.map((n, i) => ({ i, n })),
            [
                { head: 'turn', get: (r) => String(r.i), right: true },
                { head: 'model calls', get: (r) => fmt(r.n), right: true },
            ],
        );
        console.log('  Turn boundaries exist only where the transcript carries `turn_ended` (newer Cursor');
        console.log('  builds). A leading turn holding everything means the session predates that marker.');
    }
}

const args = parseArgs(process.argv);
if (args.help) {
    console.log('usage: node scripts/token-audit.mjs [--db PATH | --project NAME] [--limit N] [--transcript FILE]');
    process.exit(0);
}

if (args.transcript) {
    transcriptReport(args.transcript);
    process.exit(0);
}

let dbPath;
try {
    dbPath = resolveDb(args);
} catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
}
if (!dbPath) {
    console.error(`No observe DB under ${observeRoot()}. Start the observe server (or \`./harness up\`) first.`);
    process.exit(1);
}

report(snapshot(dbPath), args.limit);
