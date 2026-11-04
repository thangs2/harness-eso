import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-03: S1 fetch failure reports error and provides RETRY action', () => {
    const page = renderWorkOverviewPage({ project: 'p1', error: 'UI_FETCH_FAILED' });
    assert.equal(page.state, 'FAILED');
    assert.deepEqual(page.actions, ['RETRY']);
    assert.match(page.html, /UI_FETCH_FAILED/);
    assert.equal(page.html.includes('<table'), false);
});
