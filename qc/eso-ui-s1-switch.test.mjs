import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-10 / ED3: Switching project replaces all rows with zero leftover rows from old project', () => {
    const turnsA = [
        { turn_id: 'turn-a-1', work: 'task-a', level: 'sufficient' },
        { turn_id: 'turn-a-2', work: 'task-a2', level: 'sufficient' },
    ];
    const pageA = renderWorkOverviewPage({ project: 'proj-A', turns: turnsA });
    assert.equal(pageA.overview.total_turns, 2);
    assert.match(pageA.html, /turn-a-1/);

    const turnsB = Array.from({ length: 50 }, (_, i) => ({
        turn_id: `turn-b-${i}`,
        work: `task-b-${i}`,
        level: 'sufficient',
    }));
    const pageB = renderWorkOverviewPage({ project: 'proj-B', turns: turnsB });
    assert.equal(pageB.overview.total_turns, 50);
    assert.equal(pageB.html.includes('turn-a-1'), false);
    assert.equal(pageB.html.includes('turn-a-2'), false);
    assert.match(pageB.html, /turn-b-0/);
    assert.match(pageB.html, /turn-b-49/);
});
