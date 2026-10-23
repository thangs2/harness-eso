import { isoNow } from '@mu/harness-foundation/pure';
import { resolveEnforceWrites } from './eso-policy.mjs';

const CONTRACT_VERSION = '1.0.0';

const DEV_SIGNALS =
    /\b(implement|fix|bug|wbs|scaffold|backend\/mu|frontend\/|dev-runtime|tiếp tục)\b/i;

/**
 * Build TurnVerdict per shard 14.
 * @param {object} params
 */
export function buildTurnVerdict(params) {
    const {
        requestId,
        phase,
        measure,
        gaps,
        eso,
        waiver = null,
        stem = '',
        blockers = [],
    } = params;
    /*
     * One resolver, shared with `eso-policy.mjs`.
     *
     * This used to re-derive the same value here with a *different* fallback (`'off'` on one side,
     * `fail_closed` on the other), so the two files disagreed for any input that was not already
     * normalised — it stayed hidden only because `orchestrateTurn` always hands over an
     * already-resolved policy. A verdict that depends on which module you asked is exactly the kind
     * of split that makes a guard's behaviour unexplainable from its log.
     */
    const enforceWrites = resolveEnforceWrites(eso);

    const level = measure.level;
    const jevOnPartial = eso.preflight?.jevOnPartial === true;
    let allowProtectedWrite = level === 'sufficient';
    if (enforceWrites === 'fail_closed') {
        allowProtectedWrite = level === 'sufficient';
        if (jevOnPartial && level === 'partial') {
            allowProtectedWrite = false;
        }
    } else if (eso.mode === 'observe') {
        allowProtectedWrite = true;
    } else if (level === 'partial') {
        allowProtectedWrite = !jevOnPartial;
    }

    const gate = eso.cognition?.insufficientPromptGate ?? 'consent';
    const stemClass = classifyStem(params.stem);
    const consentRequired =
        gate === 'consent' && level === 'insufficient' && stemClass === 'dev-runtime';

    let consentState = 'not_required';
    if (consentRequired) {
        consentState = waiver?.ok ? 'waived' : 'pending';
    }

    let allowPromptSubmit = true;
    if (consentRequired && consentState === 'pending') {
        allowPromptSubmit = false;
    }

    /*
     * A hard blocker closes the write channel, not the conversation.
     *
     * Sufficiency says "we may not know enough to write safely"; a blocker says "this write is
     * demonstrably wrong" (a dropped column, a query with no project filter, a removed route). Both
     * stop writes. Ending the whole step is a host decision — DSH has an explicit reject for that —
     * and a host that cannot express it must not be forced into one by the engine.
     */
    const hardBlockers = Array.isArray(blockers) ? blockers.slice(0, 20) : [];
    if (hardBlockers.length) allowProtectedWrite = false;

    return {
        contractVersion: CONTRACT_VERSION,
        at: isoNow(),
        requestId,
        phase,
        sufficiency: {
            level,
            score: measure.score,
            gaps: (gaps || []).slice(0, 12),
        },
        allowPromptSubmit,
        allowProtectedWrite,
        hardBlockers,
        consent: { required: consentRequired, state: consentState },
        enforceWrites,
        esoMode: eso.mode,
        jevOnPartial: jevOnPartial && level === 'partial',
        evidenceBundleRef: null,
        decisionRef: null,
    };
}

function classifyStem(stem) {
    const s = String(stem || '').trim();
    if (!s) return 'unknown';
    if (DEV_SIGNALS.test(s)) return 'dev-runtime';
    return 'general';
}
