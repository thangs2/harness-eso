import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    judgeSufficiency,
    applyOperatorBypass,
    isBypassExpired,
    getEffectiveMode,
    evaluateEffectiveVerdict,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-22 (AC-SUF-06-01): cannot-judge with explicit bypass moves to mode=bypassed with owner and expiry', () => {
    const verdict = judgeSufficiency({
        requirements: [{ subject: 'unknown-entity', asks: 'spec', min_basis: 'retrieved', source: 'bar' }],
        answers: [{ requirement: 'unknown-entity', claim: null, basis: 'declared', exists: 'unknown' }],
    });

    assert.equal(verdict.level, 'cannot-judge');
    assert.equal(verdict.mode, 'ask');

    const bypassed = applyOperatorBypass(verdict, {
        by: 'operator-alice',
        expires_at: '2026-11-10T12:00:00.000Z',
        reason: 'Waiting for upstream RFC approval',
        now: '2026-11-04T00:00:00.000Z',
    });

    assert.equal(bypassed.mode, 'bypassed');
    assert.equal(bypassed.level, 'cannot-judge', 'INV-ESO-02: Level is never modified to sufficient');
    assert.equal(bypassed.bypass.by, 'operator-alice');
    assert.equal(bypassed.bypass.expires_at, '2026-11-10T12:00:00.000Z');
    assert.equal(bypassed.bypass.reason, 'Waiting for upstream RFC approval');
    assert.equal(bypassed.mode_selected_by, 'operator-alice');
});

test('SCN-SUF-23 (AC-SUF-06-02): Bypass without owner (by empty) is rejected before run (0 tasks run)', () => {
    const verdict = {
        level: 'cannot-judge',
        mode: 'ask',
        reason: 'all_unknown',
    };

    assert.throws(() => {
        applyOperatorBypass(verdict, {
            by: '',
            expires_at: '2026-11-10T00:00:00.000Z',
            reason: 'Bypass test',
        });
    }, (err) => {
        assert.equal(err.code, 'BYPASS_NO_OWNER');
        return true;
    });

    assert.throws(() => {
        applyOperatorBypass(verdict, {
            by: null,
            expires_at: '2026-11-10T00:00:00.000Z',
        });
    }, (err) => {
        assert.equal(err.code, 'BYPASS_NO_OWNER');
        return true;
    });
});

test('SCN-SUF-24 (AC-SUF-06-03): Bypass without expiry (expires_at empty) is rejected before run (0 tasks run)', () => {
    const verdict = {
        level: 'cannot-judge',
        mode: 'ask',
        reason: 'all_unknown',
    };

    assert.throws(() => {
        applyOperatorBypass(verdict, {
            by: 'operator-bob',
            expires_at: '',
            reason: 'Bypass test',
        });
    }, (err) => {
        assert.equal(err.code, 'BYPASS_NO_EXPIRY');
        return true;
    });

    assert.throws(() => {
        applyOperatorBypass(verdict, {
            by: 'operator-bob',
            expires_at: null,
        });
    }, (err) => {
        assert.equal(err.code, 'BYPASS_NO_EXPIRY');
        return true;
    });
});

test('SCN-SUF-25 (AC-SUF-06-04): Expired bypass reverts to ask, never permitted', () => {
    const verdict = {
        level: 'cannot-judge',
        mode: 'bypassed',
        mode_selected_by: 'operator-charlie',
        bypass: {
            by: 'operator-charlie',
            expires_at: '2026-11-04T08:00:00.000Z',
            reason: 'Temporary pass',
        },
    };

    // When time has passed
    const nowSimulated = '2026-11-04T09:00:00.000Z';
    const effective = getEffectiveMode(verdict, nowSimulated);
    assert.equal(effective, 'ask', 'Expired bypass must revert to ask');
    assert.notEqual(effective, 'permitted', 'INV-ESO-02: Expired bypass must never become permitted');

    const effectiveRecord = evaluateEffectiveVerdict(verdict, nowSimulated);
    assert.equal(effectiveRecord.mode, 'ask');
    assert.deepEqual(effectiveRecord.expired, {
        by: 'operator-charlie',
        expires_at: '2026-11-04T08:00:00.000Z',
    });
});

test('SCN-SUF-36 (AC-SUF-06-05): Exact deadline match now == expires_at is considered expired immediately (>= convention)', () => {
    const expiry = '2026-11-04T15:30:00.000Z';
    const verdict = {
        level: 'cannot-judge',
        mode: 'bypassed',
        bypass: {
            by: 'operator-dana',
            expires_at: expiry,
            reason: 'Precise deadline test',
        },
    };

    // T-1ms: Active
    assert.equal(isBypassExpired(verdict, '2026-11-04T15:29:59.999Z'), false);
    assert.equal(getEffectiveMode(verdict, '2026-11-04T15:29:59.999Z'), 'bypassed');

    // T (exact match): Expired immediately
    assert.equal(isBypassExpired(verdict, expiry), true);
    assert.equal(getEffectiveMode(verdict, expiry), 'ask');

    // T+1ms: Expired
    assert.equal(isBypassExpired(verdict, '2026-11-04T15:30:00.001Z'), true);
    assert.equal(getEffectiveMode(verdict, '2026-11-04T15:30:00.001Z'), 'ask');
});

test('SCN-SUF-37 (AC-SUF-06-06): Second bypass for same turn when first is active is rejected, preserves original by & expires_at', () => {
    const initialBypass = applyOperatorBypass({
        level: 'cannot-judge',
        mode: 'ask',
    }, {
        by: 'operator-first',
        expires_at: '2026-11-05T00:00:00.000Z',
        reason: 'First active override',
        now: '2026-11-04T00:00:00.000Z',
    });

    // Attempt second bypass while active at 2026-11-04T06:00:00.000Z
    assert.throws(() => {
        applyOperatorBypass(initialBypass, {
            by: 'operator-second',
            expires_at: '2026-11-10T00:00:00.000Z',
            reason: 'Attempted override renewal',
            now: '2026-11-04T06:00:00.000Z',
        });
    }, (err) => {
        assert.equal(err.code, 'BYPASS_ALREADY_ACTIVE');
        assert.equal(err.active_bypass.by, 'operator-first');
        assert.equal(err.active_bypass.expires_at, '2026-11-05T00:00:00.000Z');
        return true;
    });

    // Confirm original bypass values are strictly preserved
    assert.equal(initialBypass.mode, 'bypassed');
    assert.equal(initialBypass.bypass.by, 'operator-first');
    assert.equal(initialBypass.bypass.expires_at, '2026-11-05T00:00:00.000Z');
    assert.equal(initialBypass.bypass.reason, 'First active override');
});
