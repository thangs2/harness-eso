/**
 * Run ESO after Decision Facade on ingest (dedup one row per request).
 */
import crypto from 'node:crypto';
import { loadDecisionPolicy } from '@mu/harness-foundation';
import { orchestrateTurn, insertEvidenceLedger } from '@mu/harness-eso-core';
import { buildRequestDecisionContext } from './ingest-transcript.mjs';

function requestsForScope(db, cfg, scope) {
    const projectId = cfg.project.id;
    if (!scope) {
        return db.all(
            `SELECT id FROM request WHERE project_id = ? AND user_query IS NOT NULL AND trim(user_query) != ''
             ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT 80`,
            [projectId],
        );
    }
    const ids = [...(scope.requestIds || [])];
    const gens = [...(scope.generations || [])];
    if (!ids.length && !gens.length) return [];
    const idPh = ids.map(() => '?').join(',') || 'NULL';
    const genPh = gens.map(() => '?').join(',') || 'NULL';
    return db.all(
        `SELECT id FROM request WHERE project_id = ? AND (id IN (${idPh}) OR generation_id IN (${genPh}))`,
        [projectId, ...ids, ...gens],
    );
}

function requestsMissingEso(db, cfg, limit) {
    return db.all(
        `SELECT r.id FROM request r
         WHERE r.project_id = ? AND r.user_query IS NOT NULL AND trim(r.user_query) != ''
           AND NOT EXISTS (
             SELECT 1 FROM decision_ledger dl
             WHERE dl.project_id = r.project_id AND dl.request_id = r.id
               AND dl.event_type = 'evidence_sufficiency'
           )
         ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.id DESC
         LIMIT ?`,
        [cfg.project.id, limit],
    );
}

function hashEsoRequest(event, requestId, projectId) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({ event: event.event, requestId, projectId }))
        .digest('hex');
}

function bundleFromTurn(result, policy) {
    const level = result.verdict?.sufficiency?.level ?? result.measure?.level ?? 'partial';
    const score = result.verdict?.sufficiency?.score ?? result.measure?.score ?? null;
    return {
        sufficiency: { level, score },
        esoMode: policy.eso?.mode ?? 'observe',
        surface: {
            bucket: result.pack?.bucket,
            ruleIds: result.pack?.ruleIds,
        },
        gaps: result.gaps,
        verdict: result.verdict,
    };
}

/**
 * @param {import('@mu/harness-foundation').SqliteDb} db
 * @param {object} cfg
 * @param {string} requestId
 * @param {object} policy
 */
export async function runEsoForRequest(db, cfg, requestId, policy) {
    const event = buildRequestDecisionContext(db, cfg, requestId);
    if (!event) return { ok: false, reason: 'no_context' };

    const prior = db.get(
        `SELECT id FROM decision_ledger WHERE project_id = ? AND request_id = ? AND event_type = 'evidence_sufficiency' LIMIT 1`,
        [cfg.project.id, requestId],
    );
    if (prior) return { ok: false, reason: 'duplicate' };

    const hash = hashEsoRequest(event, requestId, cfg.project.id);
    const dup = db.get(
        'SELECT id FROM decision_ledger WHERE jev_request_hash = ? AND event_type = ? LIMIT 1',
        [hash, 'evidence_sufficiency'],
    );
    if (dup) return { ok: false, reason: 'hash_dup' };

    const jevRow = db.get(
        `SELECT COUNT(*) AS n FROM decision_ledger
         WHERE project_id = ? AND request_id = ? AND latency_ms_jev > 0`,
        [cfg.project.id, requestId],
    );
    const jevCallsThisTurn = Number(jevRow?.n ?? 0);

    const t0 = Date.now();
    const result = await orchestrateTurn(
        { ...event, turnId: requestId, event: event.event ?? 'turn_start' },
        {
            phase: 'full',
            cfg,
            policy,
            db,
            jevCallsThisTurn,
        },
    );
    if (result.skipped) return { ok: false, reason: result.reason || 'skipped' };

    const bundle = bundleFromTurn(result, policy);

    if (policy.ledger?.enabled !== false) {
        insertEvidenceLedger(db, {
            project_id: cfg.project.id,
            conversation_id: event.sessionId,
            request_id: requestId,
            bundle,
            eso_mode: bundle.esoMode,
            request_hash: hash,
            latency_ms: Date.now() - t0,
            jev_trace_json: null,
            jev_latency_ms: 0,
        });
    }
    /*
     * Deliberately NOT writing `.eso-bundle-stamp.json` here.
     *
     * That file is the **host's** session state: `guard-write.py` on the consumer reads it to decide
     * whether the *current* turn may write to a protected path. Ingest is neither the host nor the
     * current turn — it is a background reader catching up on history — so it has no standing to
     * answer that question, and two writers owning one verdict is how the answer silently changed.
     *
     * The host pack writes it in `preflight-hook.mjs` with the verdict it just computed. Letting the
     * plane write it too caused a real defect:
     *
     *   - `writeEsoSessionStamp` derives `enforceWrites` from its `meta` argument, which the ingest
     *     call site did not pass, so it wrote `null` — and `guard-write.py` treats
     *     `mode != fail_closed && enforceWrites != fail_closed` as "do not block". Net effect: merely
     *     having the observe plane running **opened** the ESO write gate a few seconds after every
     *     turn, the opposite of the plane being a read-only monitor.
     *   - `runEsoBackfill` reaches this function too, so backfilling an *old* request would overwrite
     *     the live turn's stamp with that old turn's verdict.
     *   - It wrote into the consumer's working tree, from the component that is supposed to own no
     *     consumer state at all.
     */
    return { ok: true };
}

/**
 * @param {import('@mu/harness-foundation').SqliteDb} db
 * @param {object} cfg
 * @param {{ requestIds?: Set<string>, generations?: Set<string> }|null} scope
 */
export async function runEsoForScope(db, cfg, scope) {
    const { policy } = loadDecisionPolicy(cfg);
    if (policy.eso?.enabled === false || process.env.HARNESS_ESO === '0') {
        return { ran: 0, skipped: 0, disabled: true };
    }

    const rows = requestsForScope(db, cfg, scope);
    let ran = 0;
    let skipped = 0;

    for (const { id } of rows) {
        const out = await runEsoForRequest(db, cfg, id, policy);
        if (out.ok) ran += 1;
        else skipped += 1;
    }

    return { ran, skipped, disabled: false };
}

export async function runEsoBackfill(db, cfg, opts = {}) {
    const { policy } = loadDecisionPolicy(cfg);
    if (policy.eso?.enabled === false || process.env.HARNESS_ESO === '0') {
        return { ran: 0, skipped: 0, disabled: true, pending: 0 };
    }
    const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
    const rows = requestsMissingEso(db, cfg, limit);
    let ran = 0;
    let skipped = 0;
    for (const { id } of rows) {
        const out = await runEsoForRequest(db, cfg, id, policy);
        if (out.ok) ran += 1;
        else skipped += 1;
    }
    const pending = db.get(
        `SELECT COUNT(*) AS n FROM request r
         WHERE r.project_id = ? AND r.user_query IS NOT NULL AND trim(r.user_query) != ''
           AND NOT EXISTS (
             SELECT 1 FROM decision_ledger dl
             WHERE dl.project_id = r.project_id AND dl.request_id = r.id
               AND dl.event_type = 'evidence_sufficiency'
           )`,
        [cfg.project.id],
    );
    return { ran, skipped, disabled: false, pending: Number(pending?.n ?? 0) };
}
