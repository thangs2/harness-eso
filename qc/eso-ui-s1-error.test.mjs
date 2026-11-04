import test from 'node:test';
import assert from 'node:assert/strict';
import {
    renderWorkOverviewPage,
    renderS1Request,
} from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-03: S1 fetch failure reports error and provides RETRY action', () => {
    const page = renderWorkOverviewPage({ project: 'p1', error: 'UI_FETCH_FAILED' });
    assert.equal(page.state, 'FAILED');
    assert.deepEqual(page.actions, ['RETRY']);
    assert.match(page.html, /UI_FETCH_FAILED/);
    assert.equal(page.html.includes('<table'), false);
});

test('AC-UI-01-03: a broken store renders ST3 and never ST1 "empty"', () => {
    const result = renderS1Request({
        project: 'p1',
        canRead: () => true,
        loadTurns: () => {
            throw new Error('SQLITE_IOERR');
        },
    });

    assert.equal(result.status, 500);
    assert.equal(result.page.state, 'FAILED');
    assert.match(result.html, /UI_FETCH_FAILED/);
    assert.match(result.html, /data-action="RETRY"/);

    // "No turns" would be a false answer for a read that failed.
    assert.equal(result.html.includes('chưa có turn nào'), false);
    assert.equal(result.html.includes('<table'), false);
    assert.equal(result.html.includes('SQLITE_IOERR'), false, 'internal errors must not leak to the page');
});
