#!/usr/bin/env node
/**
 * Ingest bench — the evidence behind WS5.
 *
 * The symptom was "the monitor freezes while ingest runs". The cause is not SQLite locking (WAL is
 * on, so readers do not block writers): it is that the ingest pass runs **on the HTTP server's
 * event loop**, and both `bun:sqlite` and `node:sqlite` block the thread that calls them. So the
 * measure that matters is not ingest throughput — it is the **latency of a normal read request
 * while a cycle runs**, because that is what an operator sees.
 *
 * The probe drives `app.handler` directly, in the same process on purpose: that is the contention
 * being measured. Two numbers come out, and the comparison between them is the point:
 *
 *   idle      — requests with no ingest running: the floor
 *   in-cycle  — the same requests while an ingest cycle is in flight
 *
 * A loop-lag probe runs alongside as a second opinion: a blocked loop fires its 2ms timer late by
 * exactly as long as it was blocked, so the largest late firing is the longest single stall.
 *
 * Usage:
 *   node scripts/bench-ingest.mjs --root ~/Workspaces/x79 [--cycles 3] [--skip-api] [--idle-ms 400]
 *
 * Reads `HARNESS_DATA_ROOT` / `HARNESS_SQLITE_PATH` exactly as the server does, so pointing it at
 * the dev DB never touches the consumer repo.
 */
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    const pref = argv.find((a) => a.startsWith(`${name}=`));
    return pref ? pref.slice(name.length + 1) : fallback;
};
const has = (name) => argv.includes(name);

const root = path.resolve(flag('--root', process.cwd()));
const cycles = Number.parseInt(flag('--cycles', '3'), 10);
const idleMs = Number.parseInt(flag('--idle-ms', '400'), 10);
const withApi = !has('--skip-api');

const { loadConfig } = await import('../packages/harness-observe-server/src/observe-config.mjs');
const { createObserveApp } = await import('../packages/harness-observe-server/src/server.mjs');
const ingestMod = await import('../packages/harness-observe-server/src/ingest.mjs');

const cfg = loadConfig(root);
if (!cfg.ok) {
    console.error(`bench-ingest: ${cfg.reason}`);
    process.exit(2);
}

const pct = (n) => `${n.toFixed(1)}ms`;

function percentiles(values) {
    const s = [...values].sort((a, b) => a - b);
    if (!s.length) return { n: 0, p50: 0, p95: 0, max: 0 };
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return { n: s.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

/** Timer-lateness probe: the largest late firing is the longest single stall of the loop. */
function lagProbe(interval = 2) {
    const samples = [];
    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        samples.push(Math.max(0, now - last - interval));
        last = now;
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        stop() {
            clearInterval(timer);
            return percentiles(samples);
        },
    };
}

/**
 * Issue `/api/requests` in a loop until the time budget runs out (`ms`) or `state.done` flips.
 *
 * @param {object} app
 * @param {{ ms?: number, state?: { done: boolean }, maxMs?: number }} opts
 */
async function apiProbe(app, opts = {}) {
    const { ms = 0, state = null, maxMs = 90000 } = opts;
    const until = ms ? performance.now() + ms : Infinity;
    const hardStop = performance.now() + maxMs;
    const lat = [];
    while ((state ? !state.done : true) && performance.now() < until && performance.now() < hardStop) {
        const t = performance.now();
        await app.handler(new Request('http://127.0.0.1/api/requests?limit=25'));
        lat.push(performance.now() - t);
    }
    return percentiles(lat);
}

const app = createObserveApp(cfg, { pollIngest: false, quiet: true, publishLiveOnBoot: false });

console.log(`bench-ingest  root=${cfg.root}`);
console.log(`              db=${cfg.storage.target}`);
console.log(`              cycles=${cycles}${withApi ? '  + /api probe' : '  (no /api probe)'}\n`);

let idle = null;
if (withApi) {
    // Warm the read path first. Without this the very first measured request is a cold cache build
    // for the whole request list, and it dominates the idle percentiles — which would make the
    // idle-vs-in-cycle comparison meaningless.
    for (let i = 0; i < 5; i += 1) await app.handler(new Request('http://127.0.0.1/api/requests?limit=25'));
    idle = await apiProbe(app, { ms: idleMs });
    console.log(
        `idle    /api/requests  n=${idle.n} p50=${pct(idle.p50)} p95=${pct(idle.p95)} max=${pct(idle.max)}`,
    );
}

const inCycle = [];
const lags = [];
let cold = true;

for (let i = 0; i < cycles; i += 1) {
    const lag = lagProbe();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();

    const state = { done: false };
    const cyclePromise = ingestMod.runIngestOnce(cfg).then((r) => {
        state.done = true;
        return r;
    });
    const probePromise = withApi ? apiProbe(app, { state }) : Promise.resolve(null);

    const report = await cyclePromise;
    const cycleApi = await probePromise;

    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const lagPct = lag.stop();

    inCycle.push(cycleApi);
    lags.push(lagPct);

    const label = cold ? 'cold' : 'warm';
    cold = false;
    console.log(
        `cycle ${i + 1} (${label}) wall=${pct(wall)} cpu=${pct(cpuMs)} loopLag p95=${pct(lagPct.p95)} max=${pct(lagPct.max)} scope=${report.skipped ? 'skipped' : (report.scope ?? '?')}`,
    );
    if (report.counts) {
        console.log(
            `              requests=${report.counts.requests} calls=${report.counts.calls} events=${report.counts.events}`,
        );
    }
    if (cycleApi) {
        console.log(
            `              /api while ingesting  n=${cycleApi.n} p50=${pct(cycleApi.p50)} p95=${pct(cycleApi.p95)} max=${pct(cycleApi.max)}`,
        );
    }
}

if (typeof ingestMod.closeIngestDb === 'function') ingestMod.closeIngestDb();

const worst = inCycle.filter(Boolean).reduce((a, c) => (c.p95 > (a?.p95 ?? 0) ? c : a), null);
const worstLag = lags.reduce((a, l) => (l.max > (a?.max ?? 0) ? l : a), null);

console.log(`\nsummary`);
if (withApi && idle) {
    console.log(`  idle p95              ${pct(idle.p95)}`);
    console.log(`  in-cycle p95 (worst)  ${pct(worst?.p95 ?? 0)}`);
    const ratio = idle.p95 > 0 ? (worst?.p95 ?? 0) / idle.p95 : Infinity;
    console.log(`  slowdown              ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'n/a'}`);
}
console.log(`  longest stall         ${pct(worstLag?.max ?? 0)}`);
console.log(`\n  In-cycle /api latency is what an operator sees as "the monitor froze".`);
