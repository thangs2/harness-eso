import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-02 / ED6: S1 loading state renders a skeleton, disables buttons, and reports the request count as data', () => {
    const page = renderWorkOverviewPage({ project: 'p1', isLoading: true });
    assert.equal(page.state, 'LOADING');
    assert.equal(page.buttons_disabled, true);
    // ESO-379 / slice H: `1` was a constant the page had no source for — a measurement nobody took. An unrecorded
    // count stays null, and the frame the page carries reports the same value rather than a second copy.
    assert.equal(page.active_requests, null);
    assert.equal(page.frame.active_requests, null);
    assert.match(page.html, /skeleton/);

    // A recorded count passes through unchanged, still with the buttons disabled.
    const withRequests = renderWorkOverviewPage({ project: 'p1', isLoading: true, activeRequests: 2 });
    assert.equal(withRequests.state, 'LOADING');
    assert.equal(withRequests.active_requests, 2);
    assert.equal(withRequests.frame.active_requests, 2);
    assert.equal(withRequests.buttons_disabled, true);
});
