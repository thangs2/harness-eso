import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-20 (AC-LEARN-01-05 & ED1): 0 risks of matching kind halts with NO_CLUSTER (0 proposals created)', () => {
    // 0 risks provided
    assert.throws(() => {
        createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks: [],
            expected_effect: 'unsat_rate reduction',
            revert: { action: 'rollback' },
        });
    }, (err) => {
        assert.equal(err.code, 'NO_CLUSTER');
        assert.match(err.message, /chưa đủ cụm/);
        return true;
    });

    // Risks of non-matching kinds only
    const otherRisks = [
        { gap_id: 'gap-x', risk_kind: 'unsupported-tool' },
        { gap_id: 'gap-y', risk_kind: 'schema-drift' },
    ];
    assert.throws(() => {
        createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks: otherRisks,
            expected_effect: 'unsat_rate reduction',
            revert: { action: 'rollback' },
        });
    }, (err) => {
        assert.equal(err.code, 'NO_CLUSTER');
        return true;
    });
});
