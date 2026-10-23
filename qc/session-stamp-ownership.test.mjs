import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeIngestDb, runIngestOnce } from '../packages/harness-observe-server/src/ingest.mjs';
import { bundleStampPath, writeBundleStampFromPreflight } from '../packages/harness-host-generic/src/eso-gap-io.mjs';

const LINE = (q) =>
    JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: `<timestamp>Mon Jan 1 2026</timestamp><user_query>${q}</user_query>` }] },
    });

function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stamp-'));
    const transcriptDir = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 's.jsonl'), `${LINE('stamp ownership')}\n`, 'utf8');
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'stamp-qc', displayName: 'Stamp QC' },
            ingest: { transcriptDir },
            storage: { driver: 'sqlite', sqlite: { path: dbPath } },
        }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            ledger: { enabled: true },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: 'fail_closed',
                thresholds: { T_low: 0.45, T_high: 0.72 },
                sources: { law: { enabled: false }, code: { enabled: false }, memory: { enabled: false } },
            },
        }),
    );
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    return {
        root,
        cfg: {
            ok: true,
            root,
            configPath: path.join(root, 'harness.config.json'),
            dataDir: path.join(root, '.harness'),
            project: { id: 'stamp-qc', displayName: 'Stamp QC' },
            enabled: true,
            sentinelPath: path.join(root, '.harness', 'DISABLED'),
            storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
            server: { host: '127.0.0.1', port: 8792 },
            ingest: { pollMs: 2000, transcriptDir, hookFiles: [] },
            decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
        },
    };
}

/**
 * The `.eso-bundle-stamp.json` verdict has exactly one owner: the host pack's preflight, which
 * computes it for the turn that is actually running.
 *
 * This file regressed once. `eso-ingest.mjs` also wrote it, deriving `enforceWrites` from a `meta`
 * argument the call site never passed, so it wrote `null` — and `guard-write.py` reads
 * `mode != fail_closed && enforceWrites != fail_closed` as "do not block". The result was that simply
 * having the observe plane running **opened** the ESO write gate a few seconds after every turn.
 *
 * So the assertion is about absence: after a full ingest pass, the consumer's session stamp must be
 * whatever the host pack last wrote — and if the host pack never wrote one, there must be none.
 */
test('ingest does not write the host session stamp', async () => {
    const { cfg, root } = project();
    try {
        const before = bundleStampPath(root, 'cursor');
        assert.equal(fs.existsSync(before), false, 'fixture starts with no stamp');

        const report = await runIngestOnce(cfg);
        assert.equal(report.ok, true);
        // The pass must have done real ESO work, otherwise the assertion below proves nothing.
        assert.equal(report.eso?.ran > 0 || report.eso?.backfill?.ran > 0, true, 'ESO must have run');

        assert.equal(
            fs.existsSync(before),
            false,
            'a background ingest pass must not author the verdict the write gate reads',
        );
    } finally {
        closeIngestDb();
    }
});

test('ingest leaves a host-pack-written stamp untouched', async () => {
    const { cfg, root } = project();
    try {
        // The host pack answers for the live turn: sufficient + allowed.
        const packVerdict = {
            ok: true,
            at: '2026-01-01T00:00:00Z',
            level: 'sufficient',
            score: 0.95,
            allowWrite: true,
            enforceWrites: 'fail_closed',
            mode: 'hint',
        };
        writeBundleStampFromPreflight(packVerdict, { eso: { mode: 'hint', enforceWrites: 'fail_closed' } }, root, 'cursor');
        const stampPath = bundleStampPath(root, 'cursor');
        const written = fs.readFileSync(stampPath, 'utf8');

        await runIngestOnce(cfg);

        assert.equal(
            fs.readFileSync(stampPath, 'utf8'),
            written,
            'ingest must not rewrite or clobber the live turn verdict',
        );
    } finally {
        closeIngestDb();
    }
});

test('the observe-server package no longer ships a session-stamp writer', () => {
    // Guards against reintroducing the second writer by import rather than by call: the module is
    // gone, so `writeEsoSessionStamp` cannot be reached from ingest at all.
    //
    // Comments are stripped before scanning. The reason this function must not be called is
    // documented in the ingest source itself, and a check that fails on its own explanation would be
    // worse than no check.
    const stripComments = (s) =>
        s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const src = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '../packages/harness-observe-server/src',
    );
    assert.equal(fs.existsSync(path.join(src, 'eso-session-stamp.mjs')), false);

    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(p);
                continue;
            }
            if (!entry.name.endsWith('.mjs')) continue;
            if (stripComments(fs.readFileSync(p, 'utf8')).includes('writeEsoSessionStamp')) {
                offenders.push(path.relative(src, p));
            }
        }
    };
    walk(src);
    assert.deepEqual(offenders, [], 'no module may reach the host session-stamp writer');
});
