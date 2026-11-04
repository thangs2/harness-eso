import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-05 / ED5: S1 partial turn displays warning badge with missing count on exact row', () => {
    const turns = [
        { turn_id: 't-1', work: 'build-slice', level: 'partial', missing: ['m1', 'm2'] },
        { turn_id: 't-clean', work: 'clean-turn', level: 'sufficient' },
    ];
    const page = renderWorkOverviewPage({ project: 'p1', turns });
    assert.equal(page.state, 'READY');

    const rowOf = (id) => page.html.match(new RegExp(`<tr data-turn-id="${id}"[\\s\\S]*?</tr>`))[0];
    assert.match(rowOf('t-1'), /⚠ 2 thiếu/);

    // 0 row drift: the badge and its count live on the partial row only.
    assert.equal(rowOf('t-clean').includes('⚠'), false);
    assert.equal((page.html.match(/⚠ 2 thiếu/g) || []).length, 1);
});
