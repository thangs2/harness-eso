import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    acceptRisk,
    inspectRiskStatus,
} from '../eso/control-plane/src/modules/debt/domain/debt.ts';

test('SCN-IAM-05-01 (AC-IAM-05-01 & AC-IAM-08-01): Open risk accepted with by + due appends event and recalculates status = accepted', () => {
    const risk = {
        id: 'risk-101',
        project: 'baplatform',
        kind: 'untested_fallback',
        status: 'open',
    };

    const eventsLog = [];
    const now = '2026-11-04T00:00:00.000Z';
    const due = '2026-11-05T00:00:00.000Z';

    const accepted = acceptRisk({
        risk,
        by: 'operator-thang',
        due,
        role: 'operator',
        now,
        eventsLog,
    });

    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.accepted_by, 'operator-thang');
    assert.equal(accepted.due, '2026-11-05T00:00:00.000Z');
    assert.equal(accepted.remaining_ms, 24 * 60 * 60 * 1000);
    assert.equal(eventsLog.length, 1);
    assert.equal(eventsLog[0].event, 'accepted');
});

test('SCN-IAM-05-02 (AC-IAM-05-02 & AC-IAM-08-02): Accepting risk without due date is rejected with MISSING_DUE_DATE', () => {
    const risk = { id: 'risk-102', status: 'open' };

    assert.throws(() => {
        acceptRisk({
            risk,
            by: 'operator-thang',
            due: '', // empty due
        });
    }, (err) => {
        assert.ok(err.code === 'ACCEPT_NO_DUE' || err.code === 'MISSING_DUE_DATE');
        return true;
    });
});

test('SCN-IAM-05-03 (AC-IAM-05-03 & AC-IAM-08-03): Accepted risk past due date recalculates to expired and records expired event', () => {
    const risk = {
        id: 'risk-103',
        status: 'accepted',
        accepted_by: 'lead',
        due: '2026-11-04T12:00:00.000Z',
    };

    const eventsLog = [];
    // Reading risk at 13:00 (past due)
    const inspected = inspectRiskStatus({
        risk,
        now: '2026-11-04T13:00:00.000Z',
        eventsLog,
    });

    assert.equal(inspected.status, 'expired');
    assert.equal(inspected.remaining_ms, 0);
    assert.equal(eventsLog.length, 1);
    assert.equal(eventsLog[0].event, 'expired');
});

test('SCN-IAM-05-04 (AC-IAM-05-04): Role lacking permission to accept risk kind rejected with FORBIDDEN_ACCEPT and audit log', () => {
    const risk = { id: 'risk-104', kind: 'architecture_debt', status: 'open' };
    const eventsLog = [];

    assert.throws(() => {
        acceptRisk({
            risk,
            by: 'agent-build',
            due: '2026-11-10T00:00:00.000Z',
            role: 'build',
            allowedKindsForRole: ['minor_lint'], // build role cannot accept architecture debt
            eventsLog,
        });
    }, (err) => {
        assert.equal(err.code, 'FORBIDDEN_ACCEPT');
        assert.equal(err.role, 'build');
        assert.equal(err.kind, 'architecture_debt');
        return true;
    });

    assert.equal(eventsLog.length, 1);
    assert.equal(eventsLog[0].event, 'accept_refused_rbac');
});

test('SCN-IAM-05-05 (AC-IAM-05-05 / ED6): Accepting already accepted risk rejected with ALREADY_ACCEPTED without mutating assignee', () => {
    const risk = {
        id: 'risk-105',
        status: 'accepted',
        accepted_by: 'original-owner',
        due: '2026-11-10T00:00:00.000Z',
    };

    assert.throws(() => {
        acceptRisk({
            risk,
            by: 'second-person',
            due: '2026-11-12T00:00:00.000Z',
        });
    }, (err) => {
        assert.equal(err.code, 'ALREADY_ACCEPTED');
        assert.equal(err.current_assignee, 'original-owner');
        return true;
    });
});

test('SCN-IAM-05-06 (AC-IAM-05-06, AC-IAM-08-04 / ED8): Acceptance and inspection exactly at due timestamp remains valid (inclusive)', () => {
    const risk = { id: 'risk-106', status: 'open' };
    const boundaryTime = '2026-11-05T15:00:00.000Z';

    const accepted = acceptRisk({
        risk,
        by: 'lead',
        due: boundaryTime,
        now: boundaryTime, // exactly at due
    });

    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.remaining_ms, 0);

    // Reading exactly at due is NOT yet expired
    const inspected = inspectRiskStatus({
        risk: accepted,
        now: boundaryTime,
    });
    assert.equal(inspected.status, 'accepted');
});

test('SCN-IAM-08-05 (AC-IAM-08-05 / ED9): Due timestamps in different timezones computed strictly via UTC', () => {
    const risk = {
        id: 'risk-107',
        status: 'accepted',
        accepted_by: 'lead',
        due: '2026-11-04T12:00:00+07:00', // UTC 05:00
    };

    // Current time UTC 04:30 (before due)
    const before = inspectRiskStatus({
        risk,
        now: '2026-11-04T04:30:00.000Z',
    });
    assert.equal(before.status, 'accepted');
    assert.equal(before.remaining_ms, 30 * 60 * 1000);

    // Current time UTC 05:01 (past due in UTC)
    const after = inspectRiskStatus({
        risk,
        now: '2026-11-04T05:01:00.000Z',
    });
    assert.equal(after.status, 'expired');
});
