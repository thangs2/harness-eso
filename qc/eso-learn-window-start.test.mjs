import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyProposalToSystem,
} from '../eso/learn/src/index.mjs';

test('SCN-LEARN-24 (AC-LEARN-03-05 & ED8): Applying sets measure_from to exact application timestamp (now)', () => {
    const proposal = {
        proposal_id: 'prop-time-exact',
        version: 1,
        status: 'proposed',
        revert: { action: 'rollback_rule' },
    };

    const exactNow = '2026-11-04T02:00:00.123Z';
    const applied = applyProposalToSystem({
        proposal,
        now: exactNow,
        windowDuration: '14d',
        actor: 'operator',
    });

    assert.equal(applied.measure_from, exactNow);
    assert.equal(applied.applied_at, exactNow);
    assert.equal(applied.measure_window.from, exactNow);
});
