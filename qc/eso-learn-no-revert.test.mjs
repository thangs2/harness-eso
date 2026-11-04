import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-02 (AC-LEARN-01-02): Missing revert or empty revert object is rejected with NO_REVERT (0 records)', () => {
    const risks = [
        { gap_id: 'gap-001', risk_kind: 'missing-evidence' },
        { gap_id: 'gap-002', risk_kind: 'missing-evidence' },
    ];

    // 1. revert missing
    assert.throws(() => {
        createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks,
            expected_effect: 'unsat_rate reduction',
        });
    }, (err) => {
        assert.equal(err.code, 'NO_REVERT');
        return true;
    });

    // 2. revert is empty object
    assert.throws(() => {
        createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks,
            expected_effect: 'unsat_rate reduction',
            revert: {},
        });
    }, (err) => {
        assert.equal(err.code, 'NO_REVERT');
        return true;
    });
});
