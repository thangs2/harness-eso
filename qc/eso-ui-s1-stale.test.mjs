import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-06 / ED8: S1 completeness ratio displays warning indicator when incomplete', () => {
    const turns = [
        { turn_id: 't-low', work: 'incomplete-graph', level: 'partial', completeness: 0.62 },
    ];
    const page = renderWorkOverviewPage({ project: 'p1', turns, isStale: true });
    assert.equal(page.state, 'STALE');
    const row = page.overview.rows.find((r) => r.turn_id === 't-low');
    assert.ok(row.completeness_bar);
    assert.equal(row.completeness_bar.warning, true);
    assert.equal(row.completeness_bar.ratio, 0.62);
});

test('AC-UI-01-06: ST6 renders a warning banner carrying the recorded ratio', () => {
    const page = renderWorkOverviewPage({
        project: 'p1',
        turns: [{ turn_id: 't-1', work: 'incomplete-graph', level: 'partial', completeness: 0.62 }],
        isStale: true,
        coverage: 0.62,
    });

    assert.equal(page.state, 'STALE');
    assert.match(page.html, /data-state="ST6_STALE"/);
    assert.match(page.html, /class="stale-banner"/);
    // The ratio is data (0,62 in the state spec) — it comes from the caller and
    // is rendered, not hardcoded.
    assert.match(page.html, /graph phủ 0,62/);
    assert.match(page.html, /phán quyết có thể sai/);
});

test('AC-UI-01-06: a stale page with no recorded ratio still warns and does not invent a number', () => {
    const page = renderWorkOverviewPage({
        project: 'p1',
        turns: [{ turn_id: 't-1', level: 'partial' }],
        isStale: true,
    });

    assert.equal(page.state, 'STALE');
    assert.match(page.html, /phán quyết có thể sai/);
    assert.equal(page.html.includes('0,62'), false);
    assert.equal(page.html.includes('0.62'), false);
});
