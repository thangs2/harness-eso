import test from 'node:test';
import assert from 'node:assert/strict';
import { renderS1Page } from '../eso/control-plane/src/modules/s1/application/s1.presenter.ts';

test('AC-UI-01-02 / ED6: S1 loading state renders skeleton with buttons disabled and 1 request', () => {
    const page = renderS1Page({ project: 'p1', isLoading: true });
    assert.equal(page.state, 'LOADING');
    assert.equal(page.buttons_disabled, true);
    assert.equal(page.active_requests, 1);
    assert.match(page.html, /skeleton/);
});
