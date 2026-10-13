import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createObserveApp, bootObserveDb } from '@mu/harness-observe-server';

function tempTenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v1-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'qc-v1', displayName: 'QC v1' },
            server: { host: '127.0.0.1', port: 0 },
            storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            profile: 'generic-eso',
            jev: { mode: 'off' },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'off' },
        }),
    );
    return {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'qc-v1', displayName: 'QC v1' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 0 },
        ingest: { pollMs: 2000, transcriptDir: '/tmp', hookFiles: [] },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
}

test('POST /v1/preflight returns TurnVerdict projection', async () => {
    const cfg = tempTenant();
    bootObserveDb(cfg);
    const app = createObserveApp(cfg, { pollIngest: false });
    app.setPort(8810);

    const res = await app.handler(
        new Request('http://127.0.0.1:8810/v1/preflight', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                userQueryStem: 'explain harness only',
                turnId: 'qc-v1-preflight',
                writeSession: false,
            }),
        }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.at, 'string');
    assert.ok(['sufficient', 'partial', 'insufficient'].includes(body.level));
    assert.equal(body.verdict?.contractVersion, '1.0.0');
});

// ---------------------------------------------------------------------------
// SP-9.2 — parity: the whole point of moving preflight into the host pack
// ---------------------------------------------------------------------------

/**
 * SP-9.2 — the whole point of moving preflight into the host pack.
 *
 * The host pack answers preflight locally; this route answers it over HTTP. `guard-brain`,
 * `guard-write` and `post-tool-hint` read whichever document was written last, so the two paths
 * MUST produce the same projection for the same turn.
 *
 * Two things make this comparison meaningful rather than flaky:
 *
 * 1. **The tenant's ESO sources are disabled.** COLLECT shells out to `docgraph` / `codegraph` with
 *    an 8s/12s timeout and caches results on disk, so two live runs can legitimately see different
 *    snippets — and under a loaded CI box one spawn can time out where the other does not. That is
 *    variance in the *input*, not in the projection, and comparing two noisy runs would be a test
 *    of the adapters. With the adapters off, COLLECT is deterministic and every derived field is
 *    comparable.
 * 2. **Only the two per-run fields are normalised**: `at` (a wall-clock stamp at second resolution)
 *    and `metrics.latencyMs` (a measurement). Everything a hook branches on is compared exactly,
 *    and the key set is compared explicitly so a route that drops or invents a field fails.
 */
test('local preflight and the HTTP route project the same document', async () => {
    const cfg = tempTenant();
    // No adapter spawning: see the note above. This is the fixture, not a workaround.
    fs.writeFileSync(
        path.join(cfg.root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            profile: 'generic-eso',
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: 'off',
                sources: {
                    law: { enabled: false },
                    code: { enabled: false },
                    memory: { enabled: false },
                },
            },
        }),
    );
    bootObserveDb(cfg);
    createObserveApp(cfg, { pollIngest: false }).setPort(8812);

    const turn = {
        event: 'turn_start',
        kernelEvent: 'prompt.submitted',
        turnId: 'parity-1',
        userQueryStem: 'same question',
        conversationId: 'c-parity',
        generationId: 'g-parity',
        harnessTree: 'cursor',
    };
    const policy = JSON.parse(
        fs.readFileSync(path.join(cfg.root, '.harness', 'decision-policy.json'), 'utf8'),
    );

    const { runV1Preflight } = await import(
        '../packages/harness-observe-server/src/routes/v1-preflight.mjs'
    );
    const viaRoute = await runV1Preflight(cfg, { ...turn, event: 'prompt.submitted' }, { writeSession: false });

    const { orchestrateTurn, buildPreflightProjection } = await import('@mu/harness-eso-core');
    const t0 = Date.now();
    const localResult = await orchestrateTurn(turn, { phase: 'preflight', cfg: { root: cfg.root }, policy });
    const viaPack = buildPreflightProjection(turn, localResult, { latencyMs: Date.now() - t0 });

    const stable = (p) => {
        const { metrics: _metrics, at: _at, ...rest } = p;
        return rest;
    };
    assert.deepEqual(Object.keys(stable(viaPack)).sort(), Object.keys(stable(viaRoute)).sort());
    assert.deepEqual(
        stable(viaPack),
        stable(viaRoute),
        'the host pack and the HTTP route disagree about the preflight document',
    );
    // The time stamp is still part of the contract: every hook that stores state keys on it.
    assert.equal(typeof viaRoute.at, 'string');
    assert.equal(typeof viaRoute.metrics?.latencyMsTotal, 'number');
});

test('the unscoped write route and its HTTP client are gone', () => {
    /*
     * F27. `POST /v1/guard/write` checked the turn's evidence but never the target path, so it denied
     * ordinary edits while sufficient evidence and allowed edits to `scripts/ci/` and `.env.local` —
     * the same defect as the pack's removed `guard-write` hook (F26), one protocol over.
     *
     * It was inert but published. Rather than leave a third, unscoped answer to "may this write
     * proceed" in the API surface, the route, its handler, its client (`sidecar-client.mjs`) and the
     * template that pointed at it are all gone. The consumer's `guard-write.py` is the one gate, and
     * it scopes by path.
     *
     * This test asserts absence, because the failure mode is someone re-adding a convenient route.
     */
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const forbidden = [
        ['route handler', 'packages/harness-observe-server/src/routes/v1-preflight.mjs', 'runV1GuardWrite'],
        ['route wiring', 'packages/harness-observe-server/src/server.mjs', 'v1/guard/write'],
        ['package export', 'packages/harness-observe-server/src/index.mjs', 'runV1GuardWrite'],
        ['http client', 'packages/harness-host-generic/src/sidecar-client.mjs', null],
        ['client template', 'packages/harness-host-generic/hooks.template.json', null],
    ];
    for (const [label, rel, needle] of forbidden) {
        const abs = path.join(repo, rel);
        if (needle === null) {
            assert.equal(fs.existsSync(abs), false, `${label} must not exist: ${rel}`);
            continue;
        }
        assert.ok(fs.existsSync(abs), `${label} missing: ${rel}`);
        assert.ok(
            !fs.readFileSync(abs, 'utf8').includes(needle),
            `${label} must not mention ${needle} (${rel})`,
        );
    }
    // And the one remaining preflight route still works, so this is a removal and not a breakage.
    const route = fs.readFileSync(
        path.join(repo, 'packages/harness-observe-server/src/routes/v1-preflight.mjs'),
        'utf8',
    );
    assert.ok(route.includes('export async function runV1Preflight'), 'preflight route must survive');
});
