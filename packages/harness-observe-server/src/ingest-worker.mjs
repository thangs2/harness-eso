#!/usr/bin/env node
/**
 * Ingest worker — the write side of the observe plane, in its own process.
 *
 * Ingest is the only part of the observe plane that writes, and it is the only part that does
 * serious synchronous work: `bun:sqlite` and `node:sqlite` both block the calling thread, and an
 * ingest pass reads transcripts, runs migrations and upserts over thousands of rows. Running that
 * on the HTTP server's event loop means every `/api` request — the monitor — queues behind it.
 *
 * Moving it out is not a performance trick, it is a role split that the product already assumes:
 * the Observatory is a **read-only** view, and the write side is a background job. Two consequences
 * that matter beyond latency:
 *
 *   - a wedged or crashing ingest can no longer take the HTTP server down with it
 *   - the server's event loop stays free, so `/api` latency no longer depends on poll interval
 *
 * Protocol (newline-delimited JSON, both directions):
 *
 *   parent → worker   {"cmd":"run","id":7,"force":false}   run one cycle now
 *                     {"cmd":"stop"}                       finish and exit
 *   worker → parent   {"type":"ready", ...}                booted, safe to use
 *                     {"type":"report","id":7|null, ...}   one cycle finished
 *
 * Usage: node ingest-worker.mjs --root <consumer>
 */
import { loadConfig } from './observe-config.mjs';
import { closeIngestDb, runIngestOnce } from './ingest.mjs';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const start = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();

const cfg = loadConfig(start);
if (!cfg.ok) {
    process.stderr.write(`ingest-worker: ${cfg.reason}\n`);
    process.exit(2);
}

/** @param {object} obj */
function send(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Single-flight guard.
 *
 * A manual run (from the UI or the CLI) and a scheduled tick can land at the same moment. Two
 * concurrent passes would open overlapping transactions against the same file and race on
 * `ingest_state`, so they are coalesced onto one in-flight promise rather than allowed to interleave.
 */
let inFlight = null;
function runLocked(opts) {
    if (inFlight) return inFlight;
    inFlight = runIngestOnce(cfg, opts).finally(() => {
        inFlight = null;
    });
    return inFlight;
}

/** Fields the parent forwards to the UI; the full report stays in the worker. */
function summarize(report, id) {
    return {
        type: 'report',
        id: id ?? null,
        at: report.at,
        ok: report.ok,
        skipped: !!report.skipped,
        counts: report.counts ?? null,
        changed: report.changed ?? null,
        idle: report.idle ?? null,
        ms: report.ms ?? null,
        scope: report.scope ?? null,
    };
}

function emit(entry, force) {
    runLocked(force ? { force: true } : {})
        .then((report) => send(summarize(report, entry.id)))
        .catch((err) => {
            send({
                type: 'report',
                id: entry.id ?? null,
                at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                ok: false,
                error: String(err?.message || err),
                counts: null,
            });
        });
}

const interval = Math.max(500, cfg.ingest.pollMs || 2000);
let stopped = false;
let timer = null;

function schedule() {
    if (stopped) return;
    timer = setInterval(() => emit({}), interval);
    if (typeof timer.unref === 'function') timer.unref();
}

function shutdown(code = 0) {
    stopped = true;
    if (timer) clearInterval(timer);
    // Let an in-flight cycle finish before closing the connection, otherwise the next process sees
    // a half-applied transaction.
    Promise.resolve(inFlight)
        .catch(() => {})
        .finally(() => {
            closeIngestDb();
            process.exit(code);
        });
}

send({
    type: 'ready',
    root: cfg.root,
    db: cfg.storage.target,
    pollMs: interval,
    pid: process.pid,
});

const deferMs = Math.max(0, Number.parseInt(process.env.HARNESS_INGEST_DEFER_MS || '0', 10) || 0);
if (deferMs > 0) setTimeout(() => emit({}), deferMs);
else emit({});
schedule();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        if (msg.cmd === 'run') emit({ id: msg.id }, msg.force);
        else if (msg.cmd === 'stop') shutdown(0);
    }
});
process.stdin.on('end', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
