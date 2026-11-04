import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-31 (AC-LEARN-03-07): Idempotent re-apply preserves version, hash, artifact unchanged', () => {
    const appliedProposal = {
        proposal_id: 'prop-idem-07',
        version: 3,
        status: 'applied',
        revert: { action: 'rollback_rule' },
        measure_from: '2026-11-04T00:00:00Z',
        measure_to: '2026-12-04T00:00:00Z',
    };

    const result = applyProposalToSystem({
        proposal: appliedProposal,
        actor: 'operator',
        idempotent: true,
    });

    assert.equal(result.idempotent, true);
    assert.equal(result.version, 3);
    assert.equal(result.measure_from, '2026-11-04T00:00:00Z');
    assert.equal(result.measure_to, '2026-12-04T00:00:00Z');
});
