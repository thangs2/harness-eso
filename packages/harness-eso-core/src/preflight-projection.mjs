/**
 * Preflight projection — the `.eso-preflight.json` document every host hook reads.
 *
 * Single source of truth for this shape. It used to be built inline in the observe-server
 * HTTP route, which meant the host could only obtain it by calling the sidecar. The host pack
 * now runs COLLECT + GATE in-process, so both callers must produce a byte-identical
 * projection from the same `orchestrateTurn` result — otherwise `guard-brain`, the ESO write
 * gate and `post-tool-hint` would read a different document depending on how preflight ran.
 *
 * @param {object} turn      the host event that triggered preflight
 * @param {object} result    `orchestrateTurn` return value
 * @param {{ latencyMs?: number }} [opts]
 */
export function buildPreflightProjection(turn, result, opts = {}) {
    const verdict = result.verdict;
    const level = verdict.sufficiency.level;
    const surface = result.facade?.route
        ? { bucket: result.facade.route.bucket }
        : { bucket: result.facade?.l0?.winner?.bucket ?? 'general' };

    return {
        ok: level !== 'insufficient' || verdict.allowPromptSubmit,
        at: verdict.at,
        harnessTree: turn.harnessTree || 'cursor',
        generationId: turn.generationId ?? turn.turnId ?? null,
        conversationId: turn.conversationId ?? null,
        userQueryStem: String(turn.userQueryStem || ''),
        allowWrite: verdict.allowProtectedWrite,
        level,
        score: verdict.sufficiency.score,
        mode: verdict.esoMode,
        enforceWrites: verdict.enforceWrites,
        gaps: verdict.sufficiency.gaps,
        brainTierHint: turn.brainTierHint || 'flash',
        surface,
        metrics: { latencyMsTotal: opts.latencyMs ?? 0 },
        verdict,
    };
}

/** The projection written when ESO is disabled — still a valid document for the other hooks. */
export function skippedPreflightProjection(reason) {
    return { ok: true, skipped: true, reason, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
