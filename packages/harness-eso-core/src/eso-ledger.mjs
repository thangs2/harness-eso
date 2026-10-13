import { insertDecisionLedger, newLedgerId } from '@mu/harness-decision';
import { isoNow } from '@mu/harness-foundation/pure';

/**
 * Persist ESO ingest row on decision_ledger (event_type evidence_sufficiency).
 * @param {object} db
 * @param {object} row
 */
export function insertEvidenceLedger(db, row) {
    const bundle = row.bundle;
    const level = bundle?.sufficiency?.level ?? 'partial';
    return insertDecisionLedger(db, {
        id: row.id || newLedgerId(),
        project_id: row.project_id,
        conversation_id: row.conversation_id,
        request_id: row.request_id,
        event_type: 'evidence_sufficiency',
        jev_mode: row.eso_mode ?? bundle?.esoMode ?? 'observe',
        resolver_winner: `eso_${level}`,
        l0_candidates_json: JSON.stringify(bundle?.surface ?? {}),
        jev_request_hash: row.request_hash ?? null,
        jev_response_json:
            row.jev_trace_json
                ? JSON.stringify({ bundle, jev: JSON.parse(row.jev_trace_json) })
                : JSON.stringify(bundle),
        top_probability: bundle?.sufficiency?.score ?? null,
        enforced_verdict: level,
        ambiguous_policy: row.eso_mode,
        latency_ms_l0: row.latency_ms ?? 0,
        latency_ms_jev: row.jev_latency_ms ?? 0,
        flash_fallback_used: false,
        created_at: row.created_at || isoNow(),
    });
}
