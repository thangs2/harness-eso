import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    revertProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-29 (AC-LEARN-05-06 & ED8): Reverting after window closed preserves prior evaluation conclusion', () => {
    const priorEvaluation = {
        concluded: true,
        effective: false,
        evaluated_at: '2026-11-01T00:00:00Z',
    };

    const appliedWithEval = {
        proposal_id: 'prop-eval-preserve',
        version: 2,
        status: 'applied',
        evaluation: priorEvaluation,
    };

    const reverted = revertProposal({
        proposal: appliedWithEval,
        actor: 'operator',
    });

    assert.equal(reverted.status, 'reverted');
    assert.deepEqual(reverted.evaluation, priorEvaluation);
});
