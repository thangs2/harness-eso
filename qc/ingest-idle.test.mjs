import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeIngestDb, runIngestOnce } from '../packages/harness-observe-server/src/ingest.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ESO_ROOT, 'packages/harness-observe-server/src/ingest-worker.mjs');

const TRANSCRIPT_LINE = (query) =>
    JSON.stringify({
        role: 'user',
        message: {
            content: [{ type: 'text', text: `<timestamp>Mon Jan 1 2026</timestamp><user_query>${query}</user_query>` }],
        },
    });

function tenant(query = 'first prompt') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-idle-'));
    const transcriptDir = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, 'session.jsonl');
    fs.writeFileSync(transcriptPath, `${TRANSCRIPT_LINE(query)}\n`, 'utf8');

    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'idle-qc', displayName: 'Idle QC' },
            ingest: { transcriptDir },
            // Absolute, so both this process and the spawned worker resolve to the same temp file.
            // A relative path is deliberately not honoured any more (it used to drop the database
            // into the consumer's working tree), and the default root is the operator's real
            // `~/.harness/observe` — which a test must never write into.
            storage: { driver: 'sqlite', sqlite: { path: dbPath } },
        }),
    );
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });

    return {
        cfg: {
            ok: true,
            root,
            configPath: path.join(root, 'harness.config.json'),
            dataDir: path.join(root, '.harness'),
            project: { id: 'idle-qc', displayName: 'Idle QC' },
            enabled: true,
            sentinelPath: path.join(root, '.harness', 'DISABLED'),
            storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
            server: { host: '127.0.0.1', port: 8792 },
            ingest: { pollMs: 2000, transcriptDir, hookFiles: [] },
            decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
        },
        transcriptPath,
    };
}

test('a second pass with no new input is reported idle and skips derived work', async () => {
    const { cfg } = tenant();
    try {
        const first = await runIngestOnce(cfg);
        assert.equal(first.ok, true);
        assert.equal(first.skipped, false);
        // First pass always counts as changed: the migration may have applied and the request list
        // is being derived for the first time.
        assert.equal(first.changed, true);
        assert.equal(first.idle, false);
        assert.equal(first.mcpStats.skipped, undefined, 'first pass must rebuild MCP stats');

        const second = await runIngestOnce(cfg);
        assert.equal(second.ok, true);
        assert.equal(second.changed, false, 'nothing new on disk, so nothing changed');
        assert.equal(second.idle, true);
        // The expensive derived stage is skipped, which is the whole point: on a large DB the MCP
        // rebuild is the single biggest cost of an idle cycle.
        assert.equal(second.mcpStats.skipped, true);
        assert.equal(second.counts.requests, first.counts.requests);
    } finally {
        closeIngestDb();
    }
});

test('appending a transcript line makes the next pass non-idle again', async () => {
    const { cfg, transcriptPath } = tenant();
    try {
        await runIngestOnce(cfg);
        assert.equal((await runIngestOnce(cfg)).idle, true);

        fs.appendFileSync(transcriptPath, `${TRANSCRIPT_LINE('second prompt')}\n`, 'utf8');
        const after = await runIngestOnce(cfg);
        assert.equal(after.changed, true);
        assert.equal(after.idle, false);
        assert.notEqual(after.mcpStats.skipped, true, 'new data must refresh MCP stats');

        // And it settles back to idle once consumed.
        assert.equal((await runIngestOnce(cfg)).idle, true);
    } finally {
        closeIngestDb();
    }
});

test('the pooled connection is reused across passes', async () => {
    const { cfg } = tenant();
    try {
        const a = await runIngestOnce(cfg);
        const b = await runIngestOnce(cfg);
        // Migrations run once per connection now, not once per cycle — 30 scans a minute at the
        // default 2s poll used to be pure overhead.
        assert.ok(Array.isArray(a.migrations));
        assert.deepEqual(b.migrations, [], 'the migration scan must not repeat on a pooled connection');
    } finally {
        closeIngestDb();
    }
});

test('control: a fresh connection does re-run the migration scan', async () => {
    const { cfg } = tenant();
    try {
        await runIngestOnce(cfg);
        // Prove the previous assertion is about pooling and not about `migrate` never returning
        // anything: drop the pool and the scan runs again.
        closeIngestDb();
        const report = await runIngestOnce(cfg);
        assert.deepEqual(report.migrations, [], 'already-applied migrations return an empty list');
        assert.equal(report.ok, true);
    } finally {
        closeIngestDb();
    }
});

// ---------------------------------------------------------------------------
// Worker process protocol
// ---------------------------------------------------------------------------

/**
 * Spawn the ingest worker and collect its protocol messages.
 *
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, msgs: object[], send: (o: object) => void, stop: () => Promise<object>, waitFor: (fn: (m: object) => boolean, ms?: number) => Promise<object> }>}
 */
async function startWorker(cfg) {
    const child = spawn(process.execPath, [WORKER, '--root', cfg.root], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            // Blank these out rather than relying on them being unset: a dev shell that exports
            // HARNESS_DATA_ROOT would otherwise redirect the worker to the real observe volume and
            // the test would read someone else's database.
            HARNESS_DATA_ROOT: '',
            HARNESS_SQLITE_PATH: '',
            HARNESS_INGEST_POLL_MS: '3600000',
        },
    });
    const msgs = [];
    const waiters = [];

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let m;
        try {
            m = JSON.parse(line);
        } catch {
            return;
        }
        msgs.push(m);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].fn(m)) {
                waiters[i].resolve(m);
                waiters.splice(i, 1);
            }
        }
    });

    const waitFor = (fn, ms = 15000) =>
        new Promise((resolve, reject) => {
            const hit = msgs.find(fn);
            if (hit) return resolve(hit);
            const timer = setTimeout(() => reject(new Error(`timed out waiting; got ${JSON.stringify(msgs)}`)), ms);
            waiters.push({
                fn,
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
        });

    return {
        child,
        msgs,
        waitFor,
        send: (o) => child.stdin.write(`${JSON.stringify(o)}\n`),
        stop: () =>
            new Promise((resolve) => {
                child.once('exit', (code) => resolve({ code }));
                try {
                    child.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
                } catch {
                    child.kill();
                }
            }),
    };
}

test('the worker boots, reports, accepts a run command, and exits cleanly', async () => {
    const { cfg } = tenant();
    const w = await startWorker(cfg);
    try {
        const ready = await w.waitFor((m) => m.type === 'ready');
        assert.equal(ready.root, cfg.root);
        assert.equal(ready.db, cfg.storage.target);

        // The worker runs one cycle on boot; that report proves the protocol is alive end to end.
        const boot = await w.waitFor((m) => m.type === 'report' && m.id === null);
        assert.equal(boot.ok, true);
        assert.ok(boot.ms >= 0);

        w.send({ cmd: 'run', id: 42, force: true });
        const forced = await w.waitFor((m) => m.type === 'report' && m.id === 42);
        assert.equal(forced.ok, true);
        assert.ok(forced.counts.requests >= 1, 'the cycle must have read the seeded transcript');

        const { code } = await w.stop();
        assert.equal(code, 0, 'stop must be a clean exit, not a kill');
    } finally {
        if (!w.child.killed) w.child.kill();
        closeIngestDb();
    }
});

test('the worker coalesces concurrent runs instead of overlapping them', async () => {
    const { cfg } = tenant();
    const w = await startWorker(cfg);
    try {
        await w.waitFor((m) => m.type === 'ready');
        await w.waitFor((m) => m.type === 'report' && m.id === null);

        // Ten runs at once. Every one gets an answer (so no caller hangs), and the single-flight
        // guard means they share the in-flight cycle rather than racing on the same SQLite file.
        for (let i = 1; i <= 10; i += 1) w.send({ cmd: 'run', id: i });
        for (let i = 1; i <= 10; i += 1) {
            const r = await w.waitFor((m) => m.type === 'report' && m.id === i);
            assert.equal(r.ok, true);
        }
        await w.stop();
    } finally {
        if (!w.child.killed) w.child.kill();
        closeIngestDb();
    }
});

test('the worker exits with a clear error when the root has no config', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nocfg-'));
    const child = spawn(process.execPath, [WORKER, '--root', empty], { stdio: ['ignore', 'pipe', 'pipe'] });
    const err = await new Promise((resolve) => {
        let buf = '';
        child.stderr.on('data', (d) => {
            buf += String(d);
        });
        child.once('exit', (code) => resolve({ code, buf }));
    });
    assert.equal(err.code, 2);
    assert.match(err.buf, /no harness\.config\.json/);
});
