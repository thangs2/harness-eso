import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-01 / ED1: S1 with 0 turns shows message and [Đổi project]', () => {
    const page = renderWorkOverviewPage({ project: 'empty-proj', turns: [] });
    assert.equal(page.state, 'EMPTY');
    assert.match(page.html, /chưa có turn nào/);
    assert.match(page.html, /CHANGE_PROJECT/);
    assert.equal(page.html.includes('<table'), false);
});
