import test from 'node:test';
import assert from 'node:assert/strict';
import { renderS1Page } from '../eso/control-plane/src/modules/s1/application/s1.presenter.ts';

test('AC-UI-01-05 / ED5: S1 partial turn displays warning badge with missing count on exact row', () => {
    const turns = [
        { turn_id: 't-1', work: 'build-slice', level: 'partial', missing: ['m1', 'm2'] },
    ];
    const page = renderS1Page({ project: 'p1', turns });
    assert.equal(page.state, 'READY');
    assert.match(page.html, /data-turn-id="t-1"/);
    assert.match(page.html, /⚠ 2 thiếu/);
});
