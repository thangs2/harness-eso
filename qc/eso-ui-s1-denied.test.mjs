import test from 'node:test';
import assert from 'node:assert/strict';
import {
    renderWorkOverviewPage,
    renderS1Request,
} from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

const DENIED_SENTENCE = 'Không có quyền truy cập hoặc dự án không tồn tại';

test('AC-UI-01-04: S1 out of scope renders identical to non-existent project with 0 disclosure', () => {
    const page = renderWorkOverviewPage({ project: 'secret-proj', hasAccess: false });
    assert.equal(page.state, 'DENIED');
    assert.match(page.html, /Không có quyền truy cập hoặc dự án không tồn tại/);
    assert.equal(page.html.includes('secret-proj'), false); // 0 disclosure
});

test('AC-UI-01-04: the denial answer is identical for a project that exists and one that does not', () => {
    const existing = renderWorkOverviewPage({ project: 'real-proj', hasAccess: false });
    const missing = renderWorkOverviewPage({ project: 'ghost-proj', hasAccess: false });

    // Same sentence AND same markup: nothing may differ between "no permission"
    // and "not found", including the title and the visible copy.
    assert.equal(existing.html, missing.html);
    assert.equal(existing.title, missing.title);
    assert.equal(existing.frame.message, DENIED_SENTENCE);
    assert.equal(missing.frame.message, DENIED_SENTENCE);
});

test('AC-UI-01-04: ST4 denied renders differently from ST1 empty', () => {
    const denied = renderWorkOverviewPage({ project: 'p1', hasAccess: false });
    const empty = renderWorkOverviewPage({ project: 'p1', turns: [] });

    assert.equal(denied.state, 'DENIED');
    assert.equal(empty.state, 'EMPTY');
    assert.notEqual(denied.html, empty.html);

    // ST1 is "a project I can see with 0 turns"; denial must not reuse that
    // sentence, or it discloses existence by negation.
    assert.equal(denied.html.includes('chưa có turn nào'), false);
    assert.match(empty.html, /chưa có turn nào/);
    assert.match(denied.html, /data-state="ST4_DENIED"/);
    assert.match(empty.html, /data-state="ST1_EMPTY"/);
});

test('AC-UI-01-04: denied is reachable through the S1 request path and answers 403', () => {
    let reads = 0;
    const result = renderS1Request({
        project: 'secret-proj',
        canRead: () => false,
        loadTurns: () => {
            reads += 1;
            return [{ turn_id: 'turn-somebody-elses' }];
        },
    });

    assert.equal(result.status, 403);
    assert.equal(result.page.state, 'DENIED');
    assert.match(result.html, new RegExp(DENIED_SENTENCE));
    assert.equal(result.html.includes('secret-proj'), false);
    assert.equal(result.html.includes('turn-somebody-elses'), false);
    assert.equal(reads, 0, 'a denied request must not read the evidence store');
});

test('AC-UI-01-04: an allowed caller still reaches the list through the same path', () => {
    // The module binds PROJECT_ACCESS to AllowAllProjectAccess while the
    // deployment has one operator token and no per-project policy. That binding
    // is what keeps the route working; denial comes from replacing it.
    const result = renderS1Request({
        project: 'p1',
        canRead: () => true,
        loadTurns: () => [{ turn_id: 'turn-1', level: 'sufficient', work: 'sửa cột tenants' }],
    });

    assert.equal(result.status, 200);
    assert.equal(result.page.state, 'READY');
    assert.match(result.html, /sửa cột tenants/);
});
