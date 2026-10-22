#!/usr/bin/env node
/**
 * Batch runner for `session-whatif.mjs`: answers "is the 12% a property of one transcript or of the
 * way this harness runs at all?"
 *
 * One session can be an artefact — a frontend ticket with an unusual amount of re-reading. A verdict
 * about whether token reduction is a product feature needs the distribution across workspaces and
 * task shapes, not the best-looking transcript.
 *
 * Input: DSH session logs (`session*.jsonl` or `session*.jsonl.zstd`) under a root directory.
 * Output: per-session table + weighted/median aggregate, as text and optionally JSON/Markdown.
 *
 * Usage
 *   node scripts/session-whatif-batch.mjs
 *   node scripts/session-whatif-batch.mjs --dir ~/.dsh/sessions --min-steps 20
 *   node scripts/session-whatif-batch.mjs --md documents/08.archive/21.session-whatif-batch.md
 *
 * The per-session analysis is delegated to `session-whatif.mjs` so both share exactly one cost model.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ANALYZER = path.join(HERE, 'session-whatif.mjs');

function parseArgs(argv) {
    const out = {
        dir: path.join(os.homedir(), '.dsh', 'sessions'),
        minSteps: 20,
        json: null,
        md: null,
        limit: 0,
        analyzerArgs: [],
        quiet: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === '--dir') out.dir = v();
        else if (a === '--min-steps') out.minSteps = Number(v());
        else if (a === '--json') out.json = v();
        else if (a === '--md') out.md = v();
        else if (a === '--limit') out.limit = Number(v());
        else if (['--ledger-every', '--ledger-tokens', '--cap-reads', '--cap-artifacts', '--summary-tokens', '--boundary', '--cpt'].includes(a)) { out.analyzerArgs.push(a, v()); }
        else if (a === '--quiet') out.quiet = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function walk(dir, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

/**
 * Decompress a DSH session log.
 *
 * The persistence backend appends one zstd FRAME per flush, so a session file is a concatenation of
 * frames. Node's `zstdDecompressSync` stops after the first frame (it returned 217 bytes of a 988 KB
 * log), which looks like "a valid but empty session" — so the CLI is the primary path, and the Node
 * binding is only a fallback for machines without `zstd`.
 */
function materialize(file, tmpDir) {
    if (!file.endsWith('.zstd')) return file;
    const dest = path.join(tmpDir, `${path.basename(file, '.zstd')}.${process.pid}.${Math.random().toString(36).slice(2)}.jsonl`);
    const cli = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 });
    if (cli.status === 0) {
        fs.writeFileSync(dest, cli.stdout);
        return dest;
    }
    const raw = fs.readFileSync(file);
    try {
        fs.writeFileSync(dest, process.getBuiltinModule('node:zlib').zstdDecompressSync(raw));
        return dest;
    } catch {
        throw new Error(`cannot decompress ${file}: install zstd (the log is multi-frame)`);
    }
}

function analyze(file, tmpDir, analyzerArgs = []) {
    const plain = materialize(file, tmpDir);
    const out = path.join(tmpDir, `whatif.${process.pid}.${Math.random().toString(36).slice(2)}.json`);
    const r = spawnSync(process.execPath, [ANALYZER, plain, '--json', out, '--quiet', ...analyzerArgs], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || `analyzer exited ${r.status}`);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (plain !== file) fs.rmSync(plain, { force: true });
    fs.rmSync(out, { force: true });
    return data;
}

function workspaceOf(file) {
    const dir = path.dirname(file);
    const rel = path.relative(path.join(os.homedir(), '.dsh', 'sessions'), dir);
    const first = rel.split(path.sep)[0] ?? '';
    return first.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '/').replace('/Users/', '~/');
}

function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(xs, p) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log('usage: node scripts/session-whatif-batch.mjs [--dir ~/.dsh/sessions] [--min-steps 20] [--json out] [--md out]');
        return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-batch-'));
    const files = walk(opts.dir);
    const rows = [];
    const skipped = [];
    for (const file of files) {
        try {
            const data = analyze(file, tmpDir, opts.analyzerArgs);
            if (data.baseline.steps < opts.minSteps) {
                skipped.push({ file, steps: data.baseline.steps, reason: `fewer than ${opts.minSteps} steps` });
                continue;
            }
            const eso = data.verdict.esoOwnedPct ?? 0;
            const host = data.verdict.hostOwnedPct ?? 0;
            rows.push({
                file,
                workspace: workspaceOf(file),
                sessionId: data.sessionId,
                steps: data.baseline.steps,
                baseline: data.baseline.cumulativeTokens,
                final: data.baseline.finalTokens,
                esoOwnedPct: eso,
                hostOwnedPct: host,
                combinedPct: data.verdict.savingPct,
                quality: data.quality,
                attribution: {
                    duplicateReadTokens: data.attribution.duplicateReadTokens,
                    artifactTokens: data.attribution.artifactTokens,
                    testOutputTokens: data.attribution.testOutputTokens,
                    readTokens: data.attribution.byTool.find((t) => t.name === 'read')?.tokens ?? 0,
                },
            });
        } catch (err) {
            skipped.push({ file, reason: err.message });
        }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    rows.sort((a, b) => b.baseline - a.baseline);
    if (opts.limit) rows.splice(opts.limit);

    const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
    const esoPcts = rows.map((r) => r.esoOwnedPct);
    const aggregate = {
        sessions: rows.length,
        skipped,
        steps: sum('steps'),
        baselineTokens: sum('baseline'),
        esoOwnedPctWeighted: sum('baseline') ? 100 * (1 - rows.reduce((a, r) => a + r.baseline * (1 - r.esoOwnedPct / 100), 0) / sum('baseline')) : 0,
        hostOwnedPctWeighted: sum('baseline') ? 100 * (1 - rows.reduce((a, r) => a + r.baseline * (1 - r.hostOwnedPct / 100), 0) / sum('baseline')) : 0,
        esoOwnedPctMedian: median(esoPcts),
        esoOwnedPctP10: pct(esoPcts, 10),
        esoOwnedPctP90: pct(esoPcts, 90),
        sessionsAtOrAbove15: esoPcts.filter((p) => p >= 15).length,
        quality: {
            blindEdits: rows.reduce((a, r) => a + r.quality.blindEdits, 0),
            errors: rows.reduce((a, r) => a + r.quality.errors, 0),
            editsAfterLastTest: rows.filter((r) => r.quality.editsAfterLastTest).length,
            noTestAtAll: rows.filter((r) => r.quality.noTestAtAll).length,
            testRuns: rows.reduce((a, r) => a + r.quality.testRuns, 0),
        },
    };
    const out = { dir: opts.dir, minSteps: opts.minSteps, aggregate, rows };
    if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify(out, null, 2)}\n`);
    if (opts.md) fs.writeFileSync(opts.md, render(out));
    if (!opts.quiet) print(out);
}

function fmt(n) {
    return Math.round(n).toLocaleString('en-US');
}

function print(out) {
    const { aggregate: a, rows } = out;
    console.log(`\nDSH sessions under ${out.dir}  (min ${out.minSteps} steps)`);
    console.log(`${a.sessions} sessions · ${fmt(a.steps)} steps · ${fmt(a.baselineTokens)} cumulative tokens\n`);
    console.log('workspace                        steps      baseline  ESO%   host%');
    for (const r of rows) {
        const ws = (r.workspace || '?').slice(0, 30).padEnd(30);
        console.log(`${ws} ${String(r.steps).padStart(6)} ${fmt(r.baseline).padStart(13)} ${String(r.esoOwnedPct).padStart(5)}% ${String(r.hostOwnedPct).padStart(6)}%`);
    }
    console.log('\nweighted ESO-owned saving : ' + a.esoOwnedPctWeighted.toFixed(1) + '%');
    console.log('median  ESO-owned saving : ' + a.esoOwnedPctMedian.toFixed(1) + '%  (p10 ' + a.esoOwnedPctP10.toFixed(1) + '% · p90 ' + a.esoOwnedPctP90.toFixed(1) + '%)');
    console.log('weighted host compaction : ' + a.hostOwnedPctWeighted.toFixed(1) + '%');
    console.log(`sessions >= 15% ESO-owned : ${a.sessionsAtOrAbove15}/${a.sessions}`);
    console.log(`quality: blindEdits=${a.quality.blindEdits} editsAfterLastTest=${a.quality.editsAfterLastTest}/${a.sessions} noTestAtAll=${a.quality.noTestAtAll}/${a.sessions} errors=${a.quality.errors}`);
    if (a.skipped.length) console.log(`skipped: ${a.skipped.length} (${a.skipped.slice(0, 3).map((s) => s.reason).join('; ')})`);
    console.log('\nverdict: ' + verdictLine(a) + '\n');
}

function verdictLine(a) {
    if (a.sessions < 3) return 'not enough sessions to generalise';
    if (a.esoOwnedPctWeighted < 15) return 'token reduction is NOT a defensible product claim (weighted ' + a.esoOwnedPctWeighted.toFixed(1) + '% < 15%)';
    if (a.esoOwnedPctWeighted < 30) return 'partial: only defensible as context-lifecycle, not retrieval';
    return 'worth building — verify with a live A/B';
}

function render(out) {
    const { aggregate: a, rows } = out;
    const l = [];
    l.push('# Session what-if — batch');
    l.push('');
    l.push(`- root: \`${out.dir}\``);
    l.push(`- sessions ≥ ${out.minSteps} steps: **${a.sessions}**, steps: **${fmt(a.steps)}**, cumulative: **${fmt(a.baselineTokens)} tok**`);
    l.push('');
    l.push('| workspace | steps | baseline tok | ESO-owned | host compaction |');
    l.push('|---|---:|---:|---:|---:|');
    for (const r of rows) l.push(`| ${r.workspace} | ${r.steps} | ${fmt(r.baseline)} | ${r.esoOwnedPct}% | ${r.hostOwnedPct}% |`);
    l.push('');
    l.push(`- weighted ESO-owned: **${a.esoOwnedPctWeighted.toFixed(1)}%**`);
    l.push(`- median ESO-owned: **${a.esoOwnedPctMedian.toFixed(1)}%** (p10 ${a.esoOwnedPctP10.toFixed(1)}%, p90 ${a.esoOwnedPctP90.toFixed(1)}%)`);
    l.push(`- weighted host compaction: **${a.hostOwnedPctWeighted.toFixed(1)}%**`);
    l.push(`- sessions ≥ 15% ESO-owned: **${a.sessionsAtOrAbove15}/${a.sessions}**`);
    l.push('');
    l.push(`**Verdict:** ${verdictLine(a)}`);
    l.push('');
    return l.join('\n');
}

try {
    main();
} catch (err) {
    console.error(`session-whatif-batch: ${err.message}`);
    process.exit(1);
}
