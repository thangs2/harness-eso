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
        targetPath = '',
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
    /*
     * A gap **nothing in this repo can close** must not hold the write gate shut (G-02/G-03).
     *
     * `fail_closed` means "do not publish on unproven evidence". A `law` gap whose term the law
     * adapter already answered with nothing is not unproven evidence the agent can produce: it is a
     * statement that this corpus does not contain the document. Counting it the same way as a file
     * the agent simply did not read meant that a consumer could read everything it owns, close every
     * closable gap, and still be refused — `atrievefin`, 2026-10-23, every turn, with the deny
     * blaming "insufficient context".
     *
     * The gap stays in the document and stays visible (it is not removed — register R6); it stops
     * being a **write** condition. Score still carries the miss: `lawRatio` is computed from the pack,
     * so the number does not improve because of this.
     */
    const blockingGaps = (Array.isArray(gaps) ? gaps : []).filter((g) => g?.unanswerable !== true);
    const gapsProven = blockingGaps.length === 0;
    let allowProtectedWrite = level === 'sufficient';
    if (enforceWrites === 'fail_closed') {
        allowProtectedWrite = level === 'sufficient' || (level === 'partial' && gapsProven);
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
        /**
         * Was `fail_closed` written by the consumer, or supplied by the strict default? (G-08)
         *
         * `resolveEnforceWrites` is deliberately conservative, and an atrievefin policy that names only
         * `mode: hint` was being refused under a posture its operator never wrote. The default stays;
         * what changes is that a refusal can no longer be explained by a key that is not in the file.
         */
        enforceWritesSource: eso.enforceWritesDeclared === false ? 'default' : 'declared',
        esoMode: eso.mode,
        jevOnPartial: jevOnPartial && level === 'partial',
        /** `eso.preflight.deferWrite`, verbatim — the guards match it against the write target. */
        deferWrite: eso.preflight?.deferWrite ?? { paths: [], mode: 'evidence' },
        evidenceBundleRef: null,
        decisionRef: null,
    };
}

/**
 * Does `targetPath` fall under a path whose *evidence* is deferred (`eso.preflight.deferWrite`)?
 *
 * Prefix, on a normalised relative path, segment-aware: `SDLC` matches `SDLC/08.wbs/README.md` and a
 * literal `SDLC/` matches the same, but `SDLC` must not match `SDLCX/`. Expressed once here because
 * three parties read it — the preflight verdict, `guard-write.py`, and `guard-shell.py` — and a guard
 * that disagrees with the verdict about *which file it is looking at* is the failure A1 exists for.
 *
 * Deferral is about **evidence**, never about **protection**: a deferred path still passes the `gated`
 * tier, the approved-write locks and the Brain stamp.
 */
export function isDeferredWritePath(deferWrite, targetPath) {
    const paths = Array.isArray(deferWrite?.paths) ? deferWrite.paths : [];
    if (!paths.length) return false;
    const norm = (p) =>
        String(p || '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\.\//, '');
    const target = norm(targetPath);
    if (!target) return false;
    return paths.some((raw) => {
        const p = norm(raw).replace(/\/+$/, '');
        if (!p) return false;
        return target === p || target.startsWith(`${p}/`);
    });
}

function classifyStem(stem) {
    const s = String(stem || '').trim();
    if (!s) return 'unknown';
    if (DEV_SIGNALS.test(s)) return 'dev-runtime';
    return 'general';
}
