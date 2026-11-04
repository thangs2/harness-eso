import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-21 (AC-LEARN-01-06 & ED6): Single risk opened twice deduplicates to count=1 < threshold, halts with NO_CLUSTER', () => {
    // A single gap_id occurred 3 times in evidence ledger
    const duplicateRisks = [
        { gap_id: 'gap-repeating-1', risk_kind: 'missing-evidence' },
        { gap_id: 'gap-repeating-1', risk_kind: 'missing-evidence' },
        { gap_id: 'gap-repeating-1', risk_kind: 'missing-evidence' },
    ];

    assert.throws(() => {
        createProposal({
            project: 'baplatform',
            risk_kind: 'missing-evidence',
            risks: duplicateRisks,
            expected_effect: 'unsat_rate reduction',
            revert: { action: 'rollback' },
        });
    }, (err) => {
        assert.equal(err.code, 'NO_CLUSTER');
        assert.equal(err.distinct_count, 1);
        return true;
    });

    // When 2 distinct gap_ids are present, proposal is accepted
    const distinctRisks = [
        { gap_id: 'gap-repeating-1', risk_kind: 'missing-evidence' },
        { gap_id: 'gap-repeating-2', risk_kind: 'missing-evidence' },
    ];

    const prop = createProposal({
        project: 'baplatform',
        risk_kind: 'missing-evidence',
        risks: distinctRisks,
        expected_effect: 'unsat_rate reduction',
        revert: { action: 'rollback' },
    });

    assert.equal(prop.evidence.length, 2);
    assert.deepEqual(prop.evidence, ['gap-repeating-1', 'gap-repeating-2']);
});
