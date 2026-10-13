/**
 * Format EvidenceBundle for harness UI.
 */

/**
 * @param {object|null} row — decision_ledger row
 */
export function parseBundleFromLedgerRow(row) {
    if (!row) return null;
    const raw = row.jev_response_json || row.evidence_json;
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

/**
 * @param {object} bundle
 */
export function formatEsoSummary(bundle) {
    if (!bundle?.sufficiency) {
        return { title: 'ESO', level: 'unknown', score: null, gaps: [], trace: [] };
    }
    return {
        title: 'Evidence Sufficiency Orchestrator',
        level: bundle.sufficiency.level,
        score: bundle.sufficiency.score,
        gaps: bundle.sufficiency.gaps || [],
        trace: bundle.retrievalTrace || [],
        allowWrite: bundle.allowWrite,
        brainTierHint: bundle.brainTierHint,
        hilQuestions: bundle.hilQuestions || [],
        surface: bundle.surface || {},
        stitchedPreview: (bundle.stitchedContext || '').slice(0, 800),
        esoMode: bundle.esoMode ?? null,
        enforceWrites: bundle.enforceWrites ?? null,
    };
}

/**
 * @param {import('./db.mjs').Db} db
 * @param {string} projectId
 * @param {string} requestId
 */
export function loadEvidenceForRequest(db, projectId, requestId) {
    const row = db.get(
        `SELECT * FROM decision_ledger
         WHERE project_id = ? AND request_id = ? AND event_type = 'evidence_sufficiency'
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, requestId],
    );
    const bundle = parseBundleFromLedgerRow(row);
    return { row, bundle, summary: formatEsoSummary(bundle) };
}
