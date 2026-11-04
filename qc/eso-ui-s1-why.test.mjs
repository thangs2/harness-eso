import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-08: S1 row provides WHY action button with exact turn_id linking to S2', () => {
    const turns = [
        { turn_id: 'turn-target-42', work: 'inspect-gate', level: 'partial', missing: ['m1'] },
    ];
    const page = renderWorkOverviewPage({ project: 'p1', turns });
    assert.match(page.html, /data-action="WHY"/);
    assert.match(page.html, /data-turn-id="turn-target-42"/);
    assert.deepEqual(page.actions, ['WHY']);
});
