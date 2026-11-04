import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposal,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-03 (AC-LEARN-01-03): Machine/agent applying proposed change is rejected with APPLY_FORBIDDEN (operator only)', () => {
    const proposal = {
        project: 'baplatform',
        proposal_id: 'prop-777',
        status: 'proposed',
    };

    // Agent attempts application
    assert.throws(() => {
        applyProposal({
            proposal,
            actor: 'agent',
        });
    }, (err) => {
        assert.equal(err.code, 'APPLY_FORBIDDEN');
        assert.equal(err.actor, 'agent');
        return true;
    });

    // Subagent attempts application
    assert.throws(() => {
        applyProposal({
            proposal,
            actor: 'subagent-build',
        });
    }, (err) => {
        assert.equal(err.code, 'APPLY_FORBIDDEN');
        return true;
    });

    // Human operator is authorized
    const applied = applyProposal({
        proposal,
        actor: 'operator',
        window: '14d',
    });
    assert.equal(applied.status, 'applied');
    assert.ok(applied.applied_at);
    assert.equal(applied.measure_window.duration, '14d');
});
