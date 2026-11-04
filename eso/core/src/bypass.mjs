/**
 * @mu/eso-core — Operator Bypass Lifecycle (ESO-120 / US-SUF-06 / Slice S1)
 *
 * Implements:
 * - AC-SUF-06-01: cannot-judge allowed to proceed if explicitly bypassed with owner and expiry.
 * - AC-SUF-06-02: reject with BYPASS_NO_OWNER if owner (by) is empty.
 * - AC-SUF-06-03: reject with BYPASS_NO_EXPIRY if expiration (expires_at) is empty.
 * - AC-SUF-06-04: past expiration deadline -> mode reverts to ask, never permitted.
 * - AC-SUF-06-05: exact clock match now == expires_at -> considered expired immediately (>= convention).
 * - AC-SUF-06-06: duplicate bypass when first is still active is rejected; preserves original by and expires_at.
 * - INV-ESO-02: cannot-judge never automatically becomes permitted; verdict level is never altered.
 * - BR-06: read-time calculation of effective mode, immutable record.
 */

export function isBypassExpired(verdict, now = new Date()) {
    if (!verdict || typeof verdict !== 'object') return false;
    if (verdict.mode !== 'bypassed') return false;
    const expiresAt = verdict.bypass?.expires_at;
    if (!expiresAt) return false;

    const currentTime = new Date(now).getTime();
    const expireTime = new Date(expiresAt).getTime();
    if (Number.isNaN(currentTime) || Number.isNaN(expireTime)) return false;

    // AC-SUF-06-05: now == expires_at is considered expired immediately (>= convention)
    return currentTime >= expireTime;
}

export function getEffectiveMode(verdict, now = new Date()) {
    if (!verdict || typeof verdict !== 'object') return 'block';
    if (verdict.mode !== 'bypassed') return verdict.mode || 'block';

    if (isBypassExpired(verdict, now)) {
        // AC-SUF-06-04: reverts to ask, never permitted
        return 'ask';
    }

    return 'bypassed';
}

export function evaluateEffectiveVerdict(verdict, now = new Date()) {
    if (!verdict || typeof verdict !== 'object') {
        throw new Error('Verdict object is required');
    }

    const effective = { ...verdict };
    if (verdict.mode === 'bypassed' && isBypassExpired(verdict, now)) {
        effective.mode = 'ask';
        effective.expired = {
            by: verdict.bypass?.by || verdict.mode_selected_by,
            expires_at: verdict.bypass?.expires_at,
        };
    }
    return effective;
}

export function applyOperatorBypass(verdict, { by, reason = 'Operator override', expires_at, now = new Date() } = {}) {
    if (!verdict || typeof verdict !== 'object') {
        throw new Error('Verdict object is required');
    }

    // AC-SUF-06-02: missing or empty by
    if (!by || typeof by !== 'string' || !by.trim()) {
        const err = new Error('BYPASS_NO_OWNER: Operator identity (by) is required for bypass');
        err.code = 'BYPASS_NO_OWNER';
        throw err;
    }

    // AC-SUF-06-03: missing or empty expires_at
    if (!expires_at || typeof expires_at !== 'string' || !expires_at.trim()) {
        const err = new Error('BYPASS_NO_EXPIRY: Expiration deadline (expires_at) is required for bypass');
        err.code = 'BYPASS_NO_EXPIRY';
        throw err;
    }

    // AC-SUF-06-06: reject duplicate bypass if an active bypass already exists
    if (verdict.mode === 'bypassed' && verdict.bypass?.expires_at) {
        if (!isBypassExpired(verdict, now)) {
            const err = new Error(`BYPASS_ALREADY_ACTIVE: Existing bypass by ${verdict.bypass.by} is still active until ${verdict.bypass.expires_at}`);
            err.code = 'BYPASS_ALREADY_ACTIVE';
            err.active_bypass = verdict.bypass;
            throw err;
        }
    }

    // INV-ESO-02: level is never altered or elevated
    return {
        ...verdict,
        mode: 'bypassed',
        mode_selected_by: by.trim(),
        bypass: {
            by: by.trim(),
            reason: reason.trim(),
            expires_at: expires_at.trim(),
            created_at: new Date(now).toISOString(),
        },
    };
}
