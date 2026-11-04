import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-13 (AC-LEARN-03-04): Reading proposal right after apply shows measuring and never effective: true', () => {
    const proposal = {
        proposal_id: 'prop-measuring-check',
        version: 1,
        status: 'proposed',
        revert: { action: 'rollback_rule' },
    };

    const applied = applyProposalToSystem({
        proposal,
        actor: 'operator',
    });

    assert.equal(applied.measurement_state, 'measuring');
    assert.equal(applied.effective, false);
    assert.notEqual(applied.effective, true);
});
