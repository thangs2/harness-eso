/**
 * Ingest orchestrator.
 *
 * Order matters: the transcript spine must exist before hooks can be linked to
 * it, and checks read both. Each stage is idempotent, so a crash mid-way just
 * means the next pass redoes the tail.
 *
 * The tracking toggle is honoured here as well as in the tracer: when it is off
 * this performs no DB write at all. `--force` exists for a deliberate backfill
 * while paused, and is the only way past it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrackingDisabled, isoNow, loadConfig } from './observe-config.mjs';
import { openDb, migrate, upsertProject, healthCheck } from './observe-db.mjs';
import { ingestTranscript, discoverTranscripts, rebuildTranscript } from './ingest-transcript.mjs';
import { ingestHookFile, linkRequests, overlayEvidence } from './ingest-hooks.mjs';
import { computeChecks } from './checks.mjs';
import { refreshRequestListCache } from './request-list-cache.mjs';
import { invalidateObserveCaches } from './observe-spine-cache.mjs';

/**
 * Pooled ingest connection.
 *
 * `runIngestOnce` used to `openDb`/`close` (and run the migration scan) on **every** cycle. At the
 * default 2s poll that is 30 connection setups and 30 migration scans a minute, each of which is a
 * fresh WAL open plus a `readdirSync` and a `SELECT` on `schema_migrations` — all synchronous, all
 * on the caller's thread. Holding one connection for the process removes the churn, and the
 * migration scan collapses to once per target.
 *
 * The pool is keyed by file path so a caller that switches tenants (tests, the CLI) still gets a
 * connection to the right database; a stale entry is closed rather than leaked.
 */
let pool = { target: null, db: null, migrated: false };

function pooledDb(cfg) {
    if (pool.db && pool.target === cfg.storage.target) return pool.db;
    closeIngestDb();
    pool = { target: cfg.storage.target, db: openDb(cfg.storage.target), migrated: false };
    return pool.db;
}

/** Run the migration scan once per connection instead of once per cycle. */
function migrateOnce(db) {
    if (pool.migrated) return [];
    const applied = migrate(db);
    pool.migrated = true;
    return applied;
}

/** Close the pooled connection. Call on server shutdown; safe to call repeatedly. */
export function closeIngestDb() {
    try {
        pool.db?.close();
    } catch {
        /* already closed */
    }
    pool = { target: null, db: null, migrated: false };
}

/**
 * Backfill cadence.
 *
 * Facade and ESO backfills walk history to converge the ledger, and they ran inside **every** pass
 * — including passes where nothing changed. On a 3223-request DB that is the single largest cost of
 * an idle cycle, paid every poll interval for no new information. They now run when something
 * changed, or every `HARNESS_BACKFILL_EVERY` cycles as a slow safety net (default 10 ≈ every 20s at
 * the 2s default poll).
 */
let cycleCount = 0;
const BACKFILL_EVERY = () => Math.max(1, Number(process.env.HARNESS_BACKFILL_EVERY || 10));

export async function runIngestOnce(cfg, opts = {}) {
    const startedAt = Date.now();
    if (!opts.force && isTrackingDisabled(cfg)) {
        return { ok: true, skipped: true, reason: 'tracking disabled (config or sentinel)', db: cfg.storage.target };
    }

    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const db = pooledDb(cfg);
    const migrations = migrateOnce(db);
    upsertProject(db, cfg);
    try {

        const transcripts = [];
        for (const t of discoverTranscripts(cfg)) {
            try {
                transcripts.push(ingestTranscript(db, cfg, t));
            } catch (err) {
                transcripts.push({ path: t, ok: false, reason: err.message });
            }
        }

        const hooks = [];
        for (const h of cfg.ingest.hookFiles) {
            try {
                hooks.push(ingestHookFile(db, cfg, h));
            } catch (err) {
                hooks.push({ path: h, ok: false, reason: err.message });
            }
        }

        const link = linkRequests(db, cfg);
        const linked = link.linked;

        /*
         * Did anything actually change this pass?
         *
         * This is the difference between a cycle that costs ~20ms and one that costs ~400ms. An
         * idle pass — no new transcript lines, no new hook events, no rebuild — has nothing to
         * recompute, so the expensive derived stages (MCP stats rebuild, cache invalidation,
         * history backfills) are skipped outright rather than re-deriving identical values.
         *
         * Cache invalidation in particular was the visible cause of the monitor stalling: dropping
         * the spine cache every 2s forced the next `/api` request to recompute its aggregates, which
         * is where the multi-hundred-ms spike came from. Not invalidating when nothing changed
         * removes the spike at its source.
         */
        const changed =
            migrations.length > 0 ||
            link.repaired > 0 ||
            link.linked > 0 ||
            transcripts.some((t) => t.rebuilt || t.newLines > 0 || t.newRequests > 0 || t.newCalls > 0) ||
            hooks.some((h) => h.rebuilt || h.newEvents > 0);
        cycleCount += 1;
        const runBackfill = changed || cycleCount % BACKFILL_EVERY() === 0;

        /*
         * Re-roll ONLY the requests this cycle touched. A rebuild, a fresh migration, or a self-healed
         * mis-link invalidates everything, so those pass null = "all". An idle pass therefore costs
         * almost nothing, which is what lets a 2s poll and 2600 historical requests coexist.
         *
         * Newly LINKED prompts: linking populates `request_rule` from the captured prompt and attaches
         * the real generation_id. We include `link.linkedRequestIds` directly into `scope.requestIds`
         * so the touched and newly linked turns are visited and recomputed without forcing a full-table
         * rebuild (which touches all rows, overwrites updated_at, and degrades ordering).
         */
        const forceFull =
            migrations.length > 0 ||
            link.repaired > 0 ||
            transcripts.some((t) => t.rebuilt) ||
            hooks.some((h) => h.rebuilt);
        let scope = null;
        if (!forceFull) {
            const requestIds = new Set();
            for (const t of transcripts) for (const id of t.touchedRequests || []) requestIds.add(id);
            for (const id of link.linkedRequestIds || []) requestIds.add(id);
            const generations = new Set();
            for (const h of hooks) for (const g of h.touchedGenerations || []) generations.add(g);
            scope = { requestIds, generations };
        }
        const overlaid = overlayEvidence(db, cfg, scope);
        const checked = computeChecks(db, cfg, scope);
        let facade = { ran: 0, skipped: 0, disabled: true };
        if (process.env.HARNESS_DECISION_FACADE !== '0') {
            const { runDecisionFacadeForScope, runFacadeBackfill } = await import('./decision-ingest.mjs');
            facade = await runDecisionFacadeForScope(db, cfg, scope);
            // Mirrors HARNESS_ESO_BACKFILL_LIMIT: scope passes only decide touched turns, so a
            // ledger that was off during earlier ingests needs a bounded walk-forward to
            // converge. 0 disables it. Gated on `runBackfill` so an idle poll does not pay for a
            // history walk it already completed.
            const facadeBackfillLimit = Number(process.env.HARNESS_FACADE_BACKFILL_LIMIT || 5);
            if (facadeBackfillLimit > 0 && runBackfill) {
                facade.backfill = await runFacadeBackfill(db, cfg, { limit: facadeBackfillLimit });
            }
        }
        let eso = { ran: 0, skipped: 0, disabled: true };
        if (process.env.HARNESS_ESO !== '0') {
            const { loadDecisionPolicy } = await import('@mu/harness-foundation');
            const { policy: decisionPolicy } = loadDecisionPolicy(cfg);
            const { runEsoForScope, runEsoBackfill } = await import('./eso-ingest.mjs');
            if (opts.esoBackfillOnly) {
                const limit = opts.esoBackfillLimit ?? 200;
                eso = await runEsoBackfill(db, cfg, { limit });
            } else {
                eso = await runEsoForScope(db, cfg, scope);
                const backfillLimit = Number(process.env.HARNESS_ESO_BACKFILL_LIMIT || 20);
                if (decisionPolicy.eso?.enabled !== false && backfillLimit > 0 && runBackfill) {
                    eso.backfill = await runEsoBackfill(db, cfg, { limit: backfillLimit });
                }
            }
        }

        /*
         * MCP attribution: converge the history walk, then read the provider's ledger.
         *
         * The walk is not gated on `runBackfill` (the transcript-change cadence). It is bounded
         * internally — a cheap "who still needs walking" count plus a limited number of transcripts
         * per pass — and it stops selecting rows once converged. Gating it on a cadence tied to
         * transcript changes meant history was never walked at all on a CLI pass where nothing had
         * changed, which is exactly the case for data that predates this feature.
         */
        let mcpUsage = { read: 0, inserted: 0, attributed: 0, unattributed: 0, skipped: 0 };
        let mcpBackfill = { scanned: 0, labels: 0, prompts: 0, remaining: 0 };
        try {
            const { backfillMcpCalls, ingestMcpUsage } = await import('./ingest-mcp-usage.mjs');
            mcpBackfill = backfillMcpCalls(db, cfg, {
                limit: Number(process.env.HARNESS_MCP_PROMPT_BACKFILL_LIMIT || 20),
            });
            mcpUsage = ingestMcpUsage(db, cfg);
        } catch (err) {
            mcpUsage = { error: String(err?.message || err) };
        }

        /*
         * MCP stats are derived purely from `llm_call` / `decision_ledger` / `mcp_call`, so rebuilding
         * them when none changed is pure waste — and on a large DB the rebuild is the most expensive
         * single stage: it selects every request id, joins the whole `llm_call` table, and upserts once
         * per request. Skipping it on idle passes is most of the cycle-time win.
         */
        let mcpStats = { updated: 0, skipped: true };
        /*
         * Attribution can add usage to requests this cycle's transcript work never touched — a
         * backfilled conversation, or a ledger line for an older turn. A scope-limited refresh would
         * silently skip exactly those, so the presence of new usage forces a full rebuild.
         */
        const usageChanged = mcpUsage.inserted > 0 || mcpBackfill.labels > 0 || mcpBackfill.prompts > 0;
        if (changed || usageChanged) {
            const { refreshMcpCallStats } = await import('./mcp-call-stats.mjs');
            const mcpScope =
                !usageChanged && scope && scope.requestIds && scope.requestIds.size
                    ? scope.requestIds
                    : null;
            mcpStats = refreshMcpCallStats(db, cfg.project.id, mcpScope);
        }

        const counts = db.get(
            `SELECT (SELECT COUNT(*) FROM request) AS requests,
                    (SELECT COUNT(*) FROM llm_call) AS calls,
                    (SELECT COUNT(*) FROM event) AS events,
                    (SELECT COUNT(*) FROM conversation) AS conversations`,
        );

        refreshRequestListCache(db, cfg.project.id, {
            requestIds: scope?.requestIds ?? null,
            all: forceFull || scope === null,
        });
        // Only when something changed: invalidating unconditionally is what made the next `/api`
        // request recompute its aggregates every couple of seconds.
        if (changed) invalidateObserveCaches();

        return {
            ok: true,
            skipped: false,
            /** `false` means the pass had nothing to do and skipped every derived stage. */
            changed,
            idle: !changed,
            migrations,
            transcripts,
            hooks,
            linked,
            repaired: link.repaired,
            corrected: link.corrected,
            checked,
            facade,
            eso,
            mcpStats,
            mcpUsage,
            mcpBackfill,
            overlaid,
            scope: scope === null ? 'all' : `${scope.requestIds.size} requests / ${scope.generations.size} gens`,
            counts,
            db: cfg.storage.target,
            driver: db.driver,
            ms: Date.now() - startedAt,
            at: isoNow(),
        };
    } catch (err) {
        /*
         * The connection is pooled, so it must not be left holding a half-applied transaction: a
         * failed `db.tx()` already rolls back, but an interrupted multi-statement stage may not.
         * Dropping the connection is the cheap way to guarantee the next cycle starts clean.
         */
        closeIngestDb();
        throw err;
    }
}

/**
 * Poll loop for the server. `onCycle` receives each report so the UI can be
 * pushed a fresh aggregate over SSE. Nothing here is allowed to throw out of the
 * interval — a broken ingest must surface in the panel, not kill the server.
 */
export function startIngestLoop(cfg, onCycle, opts = {}) {
    const interval = Math.max(500, cfg.ingest.pollMs || 2000);
    let stopped = false;
    let lastReport = null;

    const tick = () => {
        if (stopped) return;
        runIngestOnce(cfg, opts)
            .then((report) => {
                lastReport = report;
                if (onCycle) onCycle(report);
            })
            .catch((err) => {
                lastReport = { ok: false, error: err.message, at: isoNow() };
                if (onCycle) onCycle(lastReport);
            });
    };

    const deferMs = Math.max(0, Number.parseInt(process.env.HARNESS_INGEST_DEFER_MS || '0', 10) || 0);
    if (deferMs > 0) {
        setTimeout(tick, deferMs);
    } else {
        tick();
    }
    const timer = setInterval(tick, interval);
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        },
        last() {
            return lastReport;
        },
    };
}

export function transcriptSpineDiagnostics(cfg) {
    const trackingOff = isTrackingDisabled(cfg);
    const transcriptDir = cfg.ingest?.transcriptDir ?? null;
    const transcriptDirExists = Boolean(transcriptDir && fs.existsSync(transcriptDir));
    let transcriptFiles = 0;
    try {
        transcriptFiles = discoverTranscripts(cfg).length;
    } catch {
        transcriptFiles = 0;
    }
    const warnings = [];
    if (!trackingOff) {
        if (!transcriptDirExists) {
            warnings.push(
                'REQUEST spine: transcript directory missing inside observe-server. Mount host ~/.cursor to /host-cursor (compose.harness.yml) or set HARNESS_INGEST_TRANSCRIPT_DIR.',
            );
        } else if (transcriptFiles === 0) {
            warnings.push(
                'REQUEST spine: no agent-transcript JSONL files discovered yet. Chat in Cursor for this repo, then Run ingest on Status.',
            );
        }
    }
    const ok = trackingOff || (transcriptDirExists && transcriptFiles > 0);
    return {
        ok,
        transcriptDir,
        transcriptDirExists,
        transcriptFiles,
        cursorMount: process.env.HARNESS_CURSOR_MOUNT || null,
        trackingOff,
        warnings,
    };
}

export function ingestStatus(cfg) {
    const spine = transcriptSpineDiagnostics(cfg);
    if (!fs.existsSync(cfg.storage.target)) {
        return {
            dbExists: false,
            db: cfg.storage.target,
            enabled: !isTrackingDisabled(cfg),
            ...spine,
            spineOk: spine.ok,
        };
    }
    const db = openDb(cfg.storage.target);
    try {
        const health = healthCheck(db);
        const counts = db.get(
            `SELECT (SELECT COUNT(*) FROM request) AS requests,
                    (SELECT COUNT(*) FROM llm_call) AS calls,
                    (SELECT COUNT(*) FROM event) AS events,
                    (SELECT COUNT(*) FROM conversation) AS conversations`,
        );
        const sources = db.all('SELECT * FROM ingest_state WHERE project_id = ?', [cfg.project.id]);
        return {
            dbExists: true,
            enabled: !isTrackingDisabled(cfg),
            db: cfg.storage.target,
            health,
            counts,
            transcriptDir: spine.transcriptDir,
            transcriptDirExists: spine.transcriptDirExists,
            transcriptFiles: spine.transcriptFiles,
            cursorMount: spine.cursorMount,
            spineOk: spine.ok,
            warnings: spine.warnings,
            sources,
            pendingLinks: db.get(
                'SELECT COUNT(*) AS n FROM request WHERE project_id = ? AND generation_id IS NULL',
                [cfg.project.id],
            ).n,
            inProgress: db.get(
                "SELECT COUNT(*) AS n FROM request WHERE project_id = ? AND status = 'in_progress'",
                [cfg.project.id],
            ).n,
        };
    } finally {
        db.close();
    }
}

// ---- CLI entry: `bun lib/ingest.mjs [--force] [--json]`
if (import.meta.main) {
    const main = async () => {
    const force = process.argv.includes('--force');
    const asJson = process.argv.includes('--json');
    const esoBackfillOnly = process.argv.includes('--eso-backfill');
    const esoBackfillArg = process.argv.find((a) => a.startsWith('--eso-backfill-limit='));
    const esoBackfillLimit = esoBackfillArg ? Number(esoBackfillArg.split('=')[1]) : undefined;
    // Same fallback as the server: cwd first, then this file's own repo.
    let cfg = loadConfig(process.cwd());
    if (!cfg.ok) cfg = loadConfig(path.dirname(fileURLToPath(import.meta.url)));
    if (!cfg.ok) {
        console.error(`harness ingest: ${cfg.reason}`);
        process.exit(2);
    }

    /*
     * `--rebuild=<conversation id or path fragment>` — re-read matching transcripts from byte 0.
     *
     * Needed because the seam check can only detect a rewrite from bytes recorded at the cursor. A
     * cursor written before `seam_hash` existed has nothing to compare, so a stale offset that happens
     * to land on a newline is invisible to it. This is the repair for those rows; it is not part of a
     * normal pass, because it discards and re-derives the conversation's requests.
     */
    const rebuildArg = process.argv.find((a) => a.startsWith('--rebuild='));
    if (rebuildArg) {
        const target = rebuildArg.slice('--rebuild='.length).trim();
        if (!target) {
            console.error('harness ingest: --rebuild needs a conversation id or path fragment');
            process.exit(2);
        }
        const db = pooledDb(cfg);
        migrateOnce(db);
        const matches = discoverTranscripts(cfg).filter((p) => p.includes(target));
        if (!matches.length) {
            console.error(`harness ingest: no transcript matches "${target}"`);
            process.exit(2);
        }
        for (const p of matches) {
            const r = rebuildTranscript(db, cfg, p);
            console.log(`  rebuilt ${r.conversationId}: +${r.newRequests} requests, +${r.newCalls} calls`);
        }
        closeIngestDb();
        process.exit(0);
    }

    const report = await runIngestOnce(cfg, {
        force,
        esoBackfillOnly,
        esoBackfillLimit,
    });
    if (asJson) {
        console.log(JSON.stringify(report, null, 2));
    } else if (report.skipped) {
        console.log(`paused: ${report.reason}`);
    } else {
        console.log(
            `ingest ok in ${report.ms}ms — requests=${report.counts.requests} calls=${report.counts.calls} events=${report.counts.events} linked=${report.linked}`,
        );
        for (const h of report.hooks) {
            if (h.newEvents) console.log(`  hooks ${h.harness}: +${h.newEvents} events`);
        }
        for (const t of report.transcripts) {
            if (t.ok && t.newLines) console.log(`  transcript ${t.conversationId.slice(0, 8)}: +${t.newLines} lines, +${t.newRequests} requests, +${t.newCalls} calls`);
        }
    }
    process.exit(report.ok ? 0 : 1);
    };
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
