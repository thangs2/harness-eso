/**
 * @mu/eso-control-plane — Debt & Risk Acceptance with Expiry (US-IAM-05 / ESO-196 & US-IAM-08 / ESO-320)
 *
 * Implements:
 * - AC-IAM-05-01 / AC-IAM-08-01: Risk open -> accept with by + due appends event, status = accepted, remaining time computed
 * - AC-IAM-05-02 / AC-IAM-08-02: accept without due date rejected with MISSING_DUE_DATE
 * - AC-IAM-05-03 / AC-IAM-08-03: accepted risk past due date -> reading status records expired event and computes status = expired
 * - AC-IAM-05-04: Role lacking permission to accept risk kind rejected with FORBIDDEN_ACCEPT
 * - AC-IAM-05-05: Accepting already accepted risk rejected with ALREADY_ACCEPTED without mutating assignee
 * - AC-IAM-05-06 / AC-IAM-08-04: Acceptance exactly at due timestamp is valid (boundary inclusive)
 * - AC-IAM-08-05: Due timestamps in different timezones computed strictly via UTC
 */

export function acceptRisk({
    risk,
    by,
    due,
    role,
    allowedKindsForRole = null,
    now = new Date().toISOString(),
    eventsLog = [],
}: any = {}) {
    if (!risk || typeof risk !== 'object') {
        const err: any = new Error('Risk object is required');
        err.code = 'INVALID_RISK';
        throw err;
    }
    if (!by || typeof by !== 'string') {
        const err: any = new Error('Assignee (by) is required');
        err.code = 'MISSING_ASSIGNEE';
        throw err;
    }

    // AC-IAM-05-02 / AC-IAM-08-02: Missing or empty due
    if (!due || typeof due !== 'string' || due.trim() === '') {
        const err: any = new Error('ACCEPT_NO_DUE: accept requires explicit due date');
        err.code = 'ACCEPT_NO_DUE';
        err.alias = 'MISSING_DUE_DATE';
        throw err;
    }

    const dueDate = new Date(due);
    if (isNaN(dueDate.getTime())) {
        const err: any = new Error(`INVALID_DUE_DATE: '${due}' is not a valid date string`);
        err.code = 'INVALID_DUE_DATE';
        throw err;
    }

    // AC-IAM-05-05 / ED6: Duplicate accept
    if (risk.status === 'accepted') {
        const err: any = new Error(`ALREADY_ACCEPTED: Risk '${risk.id || risk.risk_id}' has already been accepted by '${risk.accepted_by}'`);
        err.code = 'ALREADY_ACCEPTED';
        err.risk_id = risk.id || risk.risk_id;
        err.current_assignee = risk.accepted_by;
        throw err;
    }

    // AC-IAM-05-04: RBAC permissions for risk kind
    if (Array.isArray(allowedKindsForRole)) {
        const riskKind = risk.kind || 'generic';
        if (!allowedKindsForRole.includes(riskKind) && !allowedKindsForRole.includes('*')) {
            const err: any = new Error(`FORBIDDEN_ACCEPT: Role '${role}' lacks permission to accept risk of kind '${riskKind}'`);
            err.code = 'FORBIDDEN_ACCEPT';
            err.role = role;
            err.kind = riskKind;
            // Record audit trail event
            eventsLog.push({
                event: 'accept_refused_rbac',
                risk_id: risk.id || risk.risk_id,
                role,
                by,
                kind: riskKind,
                timestamp: now,
            });
            throw err;
        }
    }

    const nowUtc = new Date(now).getTime();
    const dueUtc = dueDate.getTime();

    // AC-IAM-05-06 / ED8: If now > dueUtc, cannot accept an already-expired deadline
    if (nowUtc > dueUtc) {
        const err: any = new Error(`EXPIRED_DUE_DATE: Due timestamp '${due}' is already in the past`);
        err.code = 'EXPIRED_DUE_DATE';
        throw err;
    }

    const dueUtcIso = dueDate.toISOString();
    const acceptEvent = {
        event: 'accepted',
        risk_id: risk.id || risk.risk_id,
        by,
        due: dueUtcIso,
        role: role || null,
        timestamp: now,
    };
    eventsLog.push(acceptEvent);

    const remainingMs = dueUtc - nowUtc;

    return {
        ...risk,
        status: 'accepted',
        accepted_by: by,
        due: dueUtcIso,
        accepted_at: now,
        remaining_ms: remainingMs,
        events: [...(risk.events || []), acceptEvent],
    };
}

export function inspectRiskStatus({
    risk,
    now = new Date().toISOString(),
    eventsLog = [],
}: any = {}) {
    if (!risk || typeof risk !== 'object') {
        throw new Error('Risk is required');
    }

    if (risk.status !== 'accepted') {
        return { ...risk };
    }

    const nowUtc = new Date(now).getTime();
    const dueUtc = new Date(risk.due).getTime();

    // AC-IAM-08-04 / ED4: Exactly on due timestamp is still valid (not expired)
    if (nowUtc <= dueUtc) {
        return {
            ...risk,
            status: 'accepted',
            remaining_ms: dueUtc - nowUtc,
        };
    }

    // AC-IAM-05-03 & AC-IAM-08-03: Past due timestamp -> status recalculates to expired
    const expiredEvent = {
        event: 'expired',
        risk_id: risk.id || risk.risk_id,
        due: risk.due,
        checked_at: now,
        message: 'Risk acceptance passed due date without closure',
    };
    eventsLog.push(expiredEvent);

    return {
        ...risk,
        status: 'expired',
        remaining_ms: 0,
        expired_at: now,
        events: [...(risk.events || []), expiredEvent],
    };
}
