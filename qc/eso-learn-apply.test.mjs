import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-07 (AC-LEARN-03-01): Operator applies proposed item with revert -> version bumps, status applied, measure window opens', () => {
    const proposal = {
        proposal_id: 'prop-apply-001',
        version: 1,
        status: 'proposed',
        revert: { action: 'rollback_rule', target: 'rules/auth.md' },
    };

    const applied = applyProposalToSystem({
        proposal,
        actor: 'operator',
        windowDuration: '30d',
    });

    assert.equal(applied.status, 'applied');
    assert.equal(applied.version, 2);
    assert.ok(applied.measure_from);
    assert.ok(applied.measure_to);
    assert.equal(applied.measure_window.duration, '30d');
});
