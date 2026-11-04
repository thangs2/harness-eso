import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-04: S1 out of scope renders identical to non-existent project with 0 disclosure', () => {
    const page = renderWorkOverviewPage({ project: 'secret-proj', hasAccess: false });
    assert.equal(page.state, 'DENIED');
    assert.match(page.html, /Không có quyền truy cập hoặc dự án không tồn tại/);
    assert.equal(page.html.includes('secret-proj'), false); // 0 disclosure
});
