/**
 * decision_ledger persistence + request hash for dedup.
 */
import crypto from 'node:crypto';
import { isoNow } from '@mu/harness-foundation/pure';

/**
 * Stable hash for idempotent shadow compares.
 * @param {object} event
 * @param {object} ctx
 */
export function hashDecisionRequest(event, ctx = {}) {
    const payload = {
        event: event.event ?? event,
        sessionId: event.sessionId ?? ctx.sessionId,
        turnId: event.turnId ?? ctx.turnId,
        userQueryStem: event.userQueryStem ?? ctx.userQueryStem,
        touchedPaths: event.touchedPaths ?? ctx.touchedPaths ?? [],
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function newLedgerId() {
    return crypto.randomUUID();
}

/**
 * @param {{ run: (sql: string, params?: unknown[]) => void }} db
 * @param {object} row
 */
export function insertDecisionLedger(db, row) {
    const id = row.id || newLedgerId();
    const now = row.created_at || isoNow();
    db.run(
        `INSERT INTO decision_ledger (
            id, project_id, conversation_id, request_id, event_type, jev_mode,
            resolver_winner, l0_candidates_json, jev_request_hash, jev_response_json,
            top_probability, enforced_verdict, ambiguous_policy,
            latency_ms_l0, latency_ms_jev, flash_fallback_used, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            row.project_id ?? null,
            row.conversation_id ?? null,
            row.request_id ?? null,
            row.event_type,
            row.jev_mode,
            row.resolver_winner ?? null,
            row.l0_candidates_json ?? null,
            row.jev_request_hash ?? null,
            row.jev_response_json ?? null,
            row.top_probability ?? null,
            row.enforced_verdict,
            row.ambiguous_policy ?? null,
            row.latency_ms_l0 ?? 0,
            row.latency_ms_jev ?? 0,
            row.flash_fallback_used ? 1 : 0,
            now,
        ],
    );
    return id;
}

/** @param {{ get: (sql: string, params?: unknown[]) => object | undefined }} db @param {string} hash */
export function findLedgerByRequestHash(db, hash) {
    if (!hash) return null;
    return db.get('SELECT * FROM decision_ledger WHERE jev_request_hash = ? ORDER BY created_at DESC LIMIT 1', [
        hash,
    ]);
}
