import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-08: S1 row provides WHY action button with exact turn_id linking to S2', () => {
    const turns = [
        { turn_id: 'turn-target-42', work: 'inspect-gate', level: 'partial', missing: ['m1'] },
        { turn_id: 'turn-other-7', work: 'other-work', level: 'sufficient' },
    ];
    const page = renderWorkOverviewPage({ project: 'p1', turns });
    assert.deepEqual(page.actions, ['WHY']);

    // The button itself carries the turn_id S2 must open — not just the row.
    assert.match(page.html, /<button data-action="WHY" data-turn-id="turn-target-42">/);
    assert.match(page.html, /<button data-action="WHY" data-turn-id="turn-other-7">/);
});
