#!/usr/bin/env node
/**
 * @mu/harness-observe-server — REST + SSE (W4 greenfield extract).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isoNow, loadConfig, isTrackingDisabled } from './observe-config.mjs';
import { healthCheck, migrate, openDb, upsertProject } from './observe-db.mjs';
import { ingestStatus, runIngestOnce, startIngestLoop, transcriptSpineDiagnostics } from './ingest.mjs';
import { getCachedIngestStatus, getCachedTranscriptSpine } from './observe-spine-cache.mjs';
import { createApiHelpers } from './observe-api.mjs';
import { createStaticHandler, defaultObservatoryDist } from './observe-static.mjs';
import { createLivePublisher } from './observe-live.mjs';
import { runV1Preflight } from './routes/v1-preflight.mjs';
import { handleStorageGcRoute } from './routes/storage-gc.mjs';
import { handleWorkspaceRequest } from './workspace-handlers.mjs';

const SERVER_VERSION = '0.1.0';
const PACKAGE_NAME = '@mu/harness-observe-server';

export function createObserveApp(cfg, opts = {}) {
    if (!cfg?.ok) {
        throw new Error(cfg?.reason || 'invalid config');
    }

    const startedAt = opts.startedAt || isoNow();
    const clients = new Set();
    let boundPort = opts.port ?? null;
    let lastIngestCounts = null;
    const serveStatic = createStaticHandler(opts.staticRoot || defaultObservatoryDist());
    let ingestLoop = opts.ingestLoop || null;

    const api = createApiHelpers(cfg, {
        startedAt,
        actualPort: () => boundPort,
    });

    function enqueueToClients(frame) {
        for (const c of clients) {
            try {
                c.enqueue(frame);
            } catch {
                clients.delete(c);
            }
        }
    }

    const live = createLivePublisher(cfg, api, {
        enqueueToClients,
        quiet: !!opts.quiet,
        actualPort: () => boundPort,
    });

    function json(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
    }

    function broadcast(payload) {
        const frame = `data: ${JSON.stringify(payload)}\n\n`;
        for (const c of clients) {
            try {
                c.enqueue(frame);
            } catch {
                clients.delete(c);
            }
        }
    }

    async function handler(req) {
        const url = new URL(req.url, `http://${cfg.server.host}:${boundPort || cfg.server.port}`);
        const p = url.pathname;

        if (p === '/api/version') {
            return json({
                apiVersion: '1',
                package: PACKAGE_NAME,
                serverVersion: SERVER_VERSION,
                openapi: 'openapi-observe-v1.yaml',
                startedAt,
            });
        }
        if (p === '/health') {
            const legacyTotals = live.getSnapshot()?.totals ?? null;
            const spine = getCachedTranscriptSpine(cfg, () => transcriptSpineDiagnostics(cfg));
            const degraded = Boolean(!isTrackingDisabled(cfg) && spine.ok === false);
            const lastIngest = ingestLoop?.last?.() || null;
            const requestCount =
                lastIngestCounts?.requests ?? lastIngest?.counts?.requests ?? spine.requestCount ?? 0;
            return json({
                ok: true,
                degraded,
                enabled: !isTrackingDisabled(cfg),
                db: cfg.storage.target,
                ingestSpine: {
                    spineOk: spine.ok,
                    transcriptDir: spine.transcriptDir,
                    transcriptDirExists: spine.transcriptDirExists,
                    transcriptFiles: spine.transcriptFiles,
                    cursorMount: spine.cursorMount,
                    requestCount,
                    warnings: spine.warnings ?? [],
                },
                lastIngest,
                /*
                 * Which process owns ingest, and whether it is still alive. Without this the split
                 * is invisible: a dead worker looks exactly like a quiet project (no new cycles),
                 * and the operator would debug the wrong half.
                 */
                ingestOwner: ingestLoop?.mode || (ingestLoop ? 'in-process' : 'none'),
                ingestWorker: ingestLoop?.status ? ingestLoop.status() : null,
                startedAt,
                uptimeSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
                revision: live.getRevision(),
                turns: legacyTotals?.turns ?? 0,
                events: legacyTotals ? legacyTotals.events : 0,
                clients: clients.size,
            });
        }
        if (p === '/live.json') {
            if (!live.getSnapshot()) live.publishLive();
            const snap = live.getSnapshot();
            return json(
                snap || {
                    revision: live.getRevision(),
                    totals: { turns: 0, events: 0, checks: 0, failed: 0 },
                    turns: [],
                },
            );
        }
        if (p === '/api/tenant') return json(api.tenantInfo());
        if (p === '/api/requests') return json(api.listRequests(url));
        if (p.startsWith('/api/requests/')) {
            const id = decodeURIComponent(p.slice('/api/requests/'.length));
            const detail = api.getRequestDetail(id);
            return detail ? json(detail) : json({ error: 'not found', id }, 404);
        }
        if (p === '/api/calls') return json(api.getCalls(url));
        if (p === '/api/decisions') return json(api.getDecisions(url));
        if (p === '/api/decision-flow') {
            const result = api.getDecisionFlow(url);
            if (!result.ok && result.error) return json({ error: result.error }, 400);
            if (!result.ok) {
                const requestId = url.searchParams.get('requestId');
                return json({ error: 'not found', requestId }, 404);
            }
            return json(result.flow);
        }
        if (p === '/api/aggregates') return json(api.getAggregates(url));
        if (p === '/api/route/graph.json') {
            const candidates = [
                path.join(cfg.root, 'route-graph.json'),
                path.join(path.dirname(fileURLToPath(import.meta.url)), 'route-graph.json'),
            ];
            const hit = candidates.find((f) => fs.existsSync(f));
            if (!hit) {
                return json({ error: 'route-graph.json missing — run refresh route map' }, 404);
            }
            return new Response(fs.readFileSync(hit), {
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            });
        }
        if (p === '/v1/preflight' && req.method === 'POST') {
            let body = {};
            try {
                body = await req.json();
            } catch {
                return json({ error: 'invalid json' }, 400);
            }
            const out = await runV1Preflight(cfg, body, { writeSession: body.writeSession !== false });
            return json(out);
        }
        const storageRoute = handleStorageGcRoute(url, req, cfg, json);
        if (storageRoute) return storageRoute;
        if (p === '/api/ingest/status') {
            return json(getCachedIngestStatus(cfg, () => ingestStatus(cfg)));
        }
        if (p === '/api/tenants') return json(api.tenants());
        if (p === '/api/workspace' || p.startsWith('/api/workspace/')) {
            const ws = await handleWorkspaceRequest(p, req);
            if (ws) return ws;
        }
        if (p === '/api/toggle') {
            if (req.method === 'POST') {
                let body = {};
                try {
                    body = await req.json();
                } catch {
                    /* default enable */
                }
                const enabled = body.enabled !== false;
                if (enabled) {
                    if (fs.existsSync(cfg.sentinelPath)) fs.rmSync(cfg.sentinelPath, { force: true });
                } else {
                    fs.mkdirSync(path.dirname(cfg.sentinelPath), { recursive: true });
                    fs.writeFileSync(cfg.sentinelPath, `disabled at ${isoNow()} by POST /api/toggle\n`);
                }
                broadcast({ type: 'toggle', enabled });
                return json({ enabled, sentinelPath: cfg.sentinelPath, exists: fs.existsSync(cfg.sentinelPath) });
            }
            return json({
                enabled: !isTrackingDisabled(cfg),
                sentinelPath: cfg.sentinelPath,
                exists: fs.existsSync(cfg.sentinelPath),
            });
        }
        if (p === '/api/ingest/run') {
            if (req.method !== 'POST') {
                return json({ error: 'method not allowed', allow: ['POST'] }, 405);
            }
            const force = url.searchParams.get('force') === '1';
            /*
             * Delegate to the worker when one owns ingest.
             *
             * Running the cycle here would put the migration scan, transcript walk and MCP upserts
             * back on the event loop this whole split exists to protect — and two processes writing
             * the same SQLite file without the worker's single-flight guard is worse still.
             */
            const report = ingestLoop?.runOnce
                ? await ingestLoop.runOnce({ force })
                : await runIngestOnce(cfg, { force });
            if (report.counts) lastIngestCounts = report.counts;
            broadcast({
                type: 'ingest',
                at: report.at || isoNow(),
                ok: report.ok,
                counts: report.counts || null,
                skipped: !!report.skipped,
            });
            live.publishLive();
            return json(report);
        }
        if (p === '/events') {
            const stream = new ReadableStream({
                start(controller) {
                    clients.add(controller);
                    controller.enqueue(
                        `data: ${JSON.stringify({ type: 'hello', at: isoNow(), counts: lastIngestCounts })}\n\n`,
                    );
                },
                cancel() {
                    clients.delete(this);
                },
            });
            return new Response(stream, {
                headers: {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                },
            });
        }
        const staticResp = serveStatic(p);
        if (staticResp) return staticResp;
        return new Response('not found', { status: 404 });
    }

    if (opts.publishLiveOnBoot !== false) {
        live.publishLive();
    }

    return {
        handler,
        broadcast,
        publishLive: () => live.publishLive(),
        getLiveSnapshot: () => live.getSnapshot(),
        setIngestLoop(loop) {
            ingestLoop = loop;
        },
        setPort(port) {
            boundPort = port;
        },
        noteLastIngestCounts(counts) {
            if (counts) lastIngestCounts = counts;
        },
        closeClients() {
            for (const c of clients) {
                try {
                    c.close();
                } catch {
                    /* noop */
                }
            }
            clients.clear();
        },
    };
}

export function bootObserveDb(cfg) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const db = openDb(cfg.storage.target);
    migrate(db);
    upsertProject(db, cfg);
    const health = healthCheck(db);
    db.close();
    if (!health.ok) {
        throw new Error(`database unusable at ${cfg.storage.target}: ${health.error}`);
    }
}

const INGEST_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ingest-worker.mjs');

/**
 * Start ingest in its own process and return an adapter the server can drive.
 *
 * Resolves `null` when the worker cannot be started (no interpreter, immediate exit, boot timeout)
 * or when `HARNESS_INGEST_INPROC=1` asks for the old behaviour — the caller then falls back to the
 * in-process loop, so a worker problem degrades to "slower monitor" rather than "no ingest".
 *
 * @param {object} cfg
 * @param {(report: object) => void} onReport called for every finished cycle
 * @param {{ bootTimeoutMs?: number }} [opts]
 */
export async function startIngestWorker(cfg, onReport, opts = {}) {
    if (process.env.HARNESS_INGEST_INPROC === '1') return null;

    const child = spawn(process.execPath, [INGEST_WORKER, '--root', cfg.root], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    let lastReport = null;
    let exit = null;
    let stderrTail = '';
    let ready = false;
    let seq = 0;
    const pending = new Map();

    const settle = (id, value) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        p.resolve(value);
    };

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return; // a partial line is not fatal; the next one will parse
        }
        if (msg.type === 'ready') {
            ready = true;
            return;
        }
        if (msg.type !== 'report') return;
        lastReport = msg;
        if (msg.id != null) settle(msg.id, msg);
        try {
            onReport?.(msg);
        } catch {
            /* a reporting failure must not kill the worker link */
        }
    });

    child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + String(d)).slice(-2000);
    });
    child.on('error', (err) => {
        exit = { error: String(err?.message || err), at: isoNow() };
    });
    child.on('exit', (code, signal) => {
        exit = { code, signal, at: isoNow(), stderrTail: stderrTail.trim() || null };
        for (const [, p] of pending) p.resolve({ ok: false, error: 'ingest worker exited', counts: null });
        pending.clear();
    });

    const bootTimeoutMs = opts.bootTimeoutMs ?? 10_000;
    const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), bootTimeoutMs);
        const check = setInterval(() => {
            if (ready || exit) {
                clearTimeout(timer);
                clearInterval(check);
                resolve(ready);
            }
        }, 25);
        if (typeof check.unref === 'function') check.unref();
        if (typeof timer.unref === 'function') timer.unref();
    }).catch(() => false);

    if (!ok) {
        // Never leave a half-started child behind; the fallback would race it for the DB.
        try {
            child.kill();
        } catch {
            /* already gone */
        }
        return null;
    }

    return {
        mode: 'worker',
        pid: child.pid,
        /** Latest cycle summary, or null before the first one finishes. */
        last: () => lastReport,
        /** Non-null once the child exited; surfaced in `/health` so the split is observable. */
        status: () => exit,
        runOnce(ropts = {}) {
            if (exit) return Promise.resolve({ ok: false, error: 'ingest worker exited', counts: null });
            const id = ++seq;
            return new Promise((resolve) => {
                pending.set(id, { resolve });
                try {
                    child.stdin.write(`${JSON.stringify({ cmd: 'run', id, force: !!ropts.force })}\n`);
                } catch (err) {
                    pending.delete(id);
                    resolve({ ok: false, error: String(err?.message || err), counts: null });
                }
            });
        },
        stop() {
            try {
                child.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
            } catch {
                /* pipe already closed */
            }
            const kill = setTimeout(() => {
                if (!exit) {
                    try {
                        child.kill();
                    } catch {
                        /* already gone */
                    }
                }
            }, 1500);
            if (typeof kill.unref === 'function') kill.unref();
        },
    };
}

export async function startObserveServer(cfg, opts = {}) {
    bootObserveDb(cfg);
    const app = createObserveApp(cfg, opts);
    const host = opts.host || cfg.server.host;
    const basePort = opts.port || cfg.server.port;
    const pollIngest =
        opts.pollIngest !== false && process.env.HARNESS_INGEST_LOOP !== '0';
    let ingestLoop = null;
    if (pollIngest) {
        const onReport = (report) => {
            app.noteLastIngestCounts(report.counts);
            app.broadcast({
                type: 'ingest',
                at: report.at || isoNow(),
                ok: report.ok,
                counts: report.counts || null,
                skipped: !!report.skipped,
            });
            app.publishLive();
        };
        /*
         * Prefer a separate process. Ingest is the only writer and the only heavy synchronous
         * worker in the observe plane, so keeping it off this event loop is what stops the monitor
         * from stalling behind a poll. The in-process loop stays as the fallback so a worker that
         * cannot start degrades to "slower monitor" instead of "no ingest at all".
         */
        ingestLoop =
            (await startIngestWorker(cfg, onReport, { bootTimeoutMs: opts.ingestBootTimeoutMs })) ||
            startIngestLoop(cfg, onReport);
        app.setIngestLoop(ingestLoop);
    }

    const server = http.createServer((req, res) => {
        const nodeReq = new Request(`http://${host}${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
            duplex: 'half',
        });
        Promise.resolve(app.handler(nodeReq))
            .then((response) => {
                res.statusCode = response.status;
                response.headers.forEach((v, k) => res.setHeader(k, v));
                if (response.body) {
                    const reader = response.body.getReader();
                    const pump = () =>
                        reader.read().then(({ done, value }) => {
                            if (done) {
                                res.end();
                                return;
                            }
                            res.write(value);
                            return pump();
                        });
                    return pump();
                }
                res.end();
            })
            .catch((err) => {
                res.statusCode = 500;
                res.end(err.message);
            });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(basePort, host, () => {
            app.setPort(server.address().port);
            resolve();
        });
    });

    return {
        app,
        server,
        ingest: ingestLoop,
        port: server.address().port,
        url: `http://${host}:${server.address().port}`,
        close() {
            ingestLoop?.stop();
            app.closeClients();
            server.close();
        },
    };
}

const ENTRY = fileURLToPath(import.meta.url);

function isDirectRun() {
    if (import.meta.main) return true;
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(ENTRY);
}

if (isDirectRun()) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const rootIdx = argv.indexOf('--root');
    const start = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
    const cfg = loadConfig(start);
    if (!cfg.ok) {
        console.error(`harness-observe-server: ${cfg.reason}`);
        process.exit(2);
    }
    const portArg = argv.indexOf('--port');
    const port = portArg >= 0 ? Number.parseInt(argv[portArg + 1], 10) : undefined;
    const { url } = await startObserveServer(cfg, { port });
    console.log(`observe server listening ${url}`);
}
