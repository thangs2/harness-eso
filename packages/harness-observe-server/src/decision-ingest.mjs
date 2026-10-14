/**
 * Run Decision Facade once per request boundary after ingest + checks.
 */
import {
    decide,
    findLedgerByRequestHash,
    hashDecisionRequest,
} from '@mu/harness-decision';
import { loadDecisionPolicy } from '@mu/harness-foundation';
import { buildRequestDecisionContext } from './ingest-transcript.mjs';

function requestsForScope(db, cfg, scope) {
    const projectId = cfg.project.id;
    if (!scope) {
        return db.all(
            `SELECT id FROM request WHERE project_id = ? AND generation_id IS NOT NULL ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT 80`,
            [projectId],
        );
    }
    const ids = [...(scope.requestIds || [])];
    const gens = [...(scope.generations || [])];
    if (!ids.length && !gens.length) return [];
    const idPh = ids.map(() => '?').join(',') || 'NULL';
    const genPh = gens.map(() => '?').join(',') || 'NULL';
    return db.all(
        `SELECT id FROM request
         WHERE project_id = ? AND (id IN (${idPh}) OR generation_id IN (${genPh}))`,
        [projectId, ...ids, ...gens],
    );
}

/** Ledger event types the facade owns (anything except ESO's evidence row). */
const FACADE_EVENT_TYPES = `('turn_start', 'pre_guard_shell')`;

/**
 * Requests that have no facade ledger row at all.
 *
 * `runDecisionFacadeForScope` is driven by the tokens an ingest cycle touched, so a pass
 * that touches nothing writes nothing. If the ledger was disabled (or the facade failed)
 * while those turns were ingested, they stay rowless forever — the design graph then falls
 * back to the coarse transcript-tool highlight and the request path never lights up.
 */
function requestsMissingFacade(db, cfg, limit) {
    return db.all(
        `SELECT r.id FROM request r
         WHERE r.project_id = ? AND r.generation_id IS NOT NULL
           AND r.user_query IS NOT NULL AND trim(r.user_query) != ''
           AND NOT EXISTS (
             SELECT 1 FROM decision_ledger dl
             WHERE dl.project_id = r.project_id AND dl.request_id = r.id
               AND dl.event_type IN ${FACADE_EVENT_TYPES}
           )
         ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.id DESC
         LIMIT ?`,
        [cfg.project.id, limit],
    );
}

function pendingFacadeCount(db, cfg) {
    const row = db.get(
        `SELECT COUNT(*) AS n FROM request r
         WHERE r.project_id = ? AND r.generation_id IS NOT NULL
           AND r.user_query IS NOT NULL AND trim(r.user_query) != ''
           AND NOT EXISTS (
             SELECT 1 FROM decision_ledger dl
             WHERE dl.project_id = r.project_id AND dl.request_id = r.id
               AND dl.event_type IN ${FACADE_EVENT_TYPES}
           )`,
        [cfg.project.id],
    );
    return Number(row?.n ?? 0);
}

/**
 * Decide one request, honouring the guards that make the pass idempotent.
 * @returns {'ran'|'no_context'|'skipped'}
 */
async function decideOne(db, cfg, id, policy) {
    const event = buildRequestDecisionContext(db, cfg, id);
    if (!event) return 'no_context';
    const eventType = event.event || 'turn_start';
    if (eventType !== 'turn_start' && eventType !== 'pre_guard_shell') return 'skipped';
    if (eventType === 'turn_start') {
        const prior = db.get(
            `SELECT id FROM decision_ledger WHERE project_id = ? AND request_id = ? AND event_type = 'turn_start' LIMIT 1`,
            [cfg.project.id, id],
        );
        if (prior) return 'skipped';
    }
    const hash = hashDecisionRequest(event, { turnId: id, projectId: cfg.project.id });
    if (findLedgerByRequestHash(db, hash)) return 'skipped';

    await decide(event, {
        cfg,
        db,
        policy,
        projectId: cfg.project.id,
        turnId: id,
        sessionId: event.sessionId,
        touchedPaths: event.touchedPaths,
        userQueryStem: event.userQueryStem,
        // `decide()` only persists when this is true (`if (ctx.writeLedger && ctx.db)`), and
        // no caller passed it — so the facade computed a route for every turn and wrote
        // nothing, leaving the design graph with no decision rows to highlight. Honour
        // `ledger.enabled` so the policy switch still governs it.
        writeLedger: policy.ledger?.enabled !== false,
    });
    return 'ran';
}

/**
 * @param {import('@mu/harness-foundation').SqliteDb} db
 * @param {object} cfg
 * @param {{ requestIds?: Set<string>, generations?: Set<string> }|null} scope
 */
export async function runDecisionFacadeForScope(db, cfg, scope) {
    const { policy } = loadDecisionPolicy(cfg);
    if (policy.facade?.runOnIngest === false) {
        return { ran: 0, skipped: 0, disabled: true };
    }

    const rows = requestsForScope(db, cfg, scope);
    let ran = 0;
    let skipped = 0;

    for (const { id } of rows) {
        const outcome = await decideOne(db, cfg, id, policy);
        if (outcome === 'ran') ran += 1;
        else skipped += 1;
    }

    return { ran, skipped, disabled: false };
}

/**
 * Facade backfill — the counterpart to `runEsoBackfill`, for the same reason.
 *
 * Scope-driven ingest only decides the turns a cycle touched, so turns ingested while the
 * ledger was off never get a `turn_start` row and their design graph degrades to the
 * transcript-tool fallback. This walks the rowless ones, newest first, so history
 * converges instead of staying permanently un-decided.
 *
 * Gated on `ledger.enabled`: with the ledger off the decisions cannot be persisted, so
 * looking for missing rows would return the same set forever.
 */
export async function runFacadeBackfill(db, cfg, opts = {}) {
    const { policy } = loadDecisionPolicy(cfg);
    if (policy.facade?.runOnIngest === false || policy.ledger?.enabled === false) {
        return { ran: 0, skipped: 0, disabled: true, pending: 0 };
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 25));
    const rows = requestsMissingFacade(db, cfg, limit);
    let ran = 0;
    let skipped = 0;
    for (const { id } of rows) {
        const outcome = await decideOne(db, cfg, id, policy);
        if (outcome === 'ran') ran += 1;
        else skipped += 1;
    }
    return { ran, skipped, disabled: false, pending: pendingFacadeCount(db, cfg) };
}
