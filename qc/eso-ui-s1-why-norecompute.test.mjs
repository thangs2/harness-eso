import test from 'node:test';
import assert from 'node:assert/strict';
import { projectS2WhyDetails } from '../eso/core/src/ui-frames.mjs';

test('AC-UI-01-09: S2 opens recorded diagnosis without recomputing new verdicts', () => {
    const historicalTurn = {
        turn_id: 'turn-historical-1',
        record: {
            verdict: 'partial',
            evidence: ['test_pass'],
            basis: 'verified',
            rule_version: 4,
            unknowns: [],
        },
    };
    const s2View = projectS2WhyDetails({ turn: historicalTurn });
    assert.equal(s2View.state, 'READY');
    assert.equal(s2View.turn_id, 'turn-historical-1');
    assert.equal(s2View.four_parts.part_1_verdict, 'partial');
    assert.deepEqual(s2View.four_parts.part_2_evidence, ['test_pass']);
    assert.equal(s2View.back_action, 'BACK_TO_S1');
});
