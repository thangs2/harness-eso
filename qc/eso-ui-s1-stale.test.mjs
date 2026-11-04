import test from 'node:test';
import assert from 'node:assert/strict';
import { renderS1Page } from '../eso/control-plane/src/modules/s1/application/s1.presenter.ts';

test('AC-UI-01-06 / ED8: S1 completeness ratio displays warning indicator when incomplete', () => {
    const turns = [
        { turn_id: 't-low', work: 'incomplete-graph', level: 'partial', completeness: 0.62 },
    ];
    const page = renderS1Page({ project: 'p1', turns, isStale: true });
    assert.equal(page.state, 'STALE');
    const row = page.overview.rows.find((r) => r.turn_id === 't-low');
    assert.ok(row.completeness_bar);
    assert.equal(row.completeness_bar.warning, true);
    assert.equal(row.completeness_bar.ratio, 0.62);
});
