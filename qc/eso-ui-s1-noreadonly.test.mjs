import test from 'node:test';
import assert from 'node:assert/strict';
import { renderS1Page } from '../eso/control-plane/src/modules/s1/application/s1.presenter.ts';

test('AC-UI-01-11: S1 is strictly read-only with 0 mutation/write buttons', () => {
    const turns = [
        { turn_id: 't-1', work: 'inspect', level: 'sufficient' },
    ];
    const page = renderS1Page({ project: 'p1', turns });
    assert.equal(page.has_write_buttons, false);
    assert.equal(page.overview.has_write_buttons, false);
    assert.equal(page.html.includes('data-action="SAVE"'), false);
    assert.equal(page.html.includes('data-action="WRITE"'), false);
    assert.equal(page.html.includes('data-action="MUTATE"'), false);
    assert.equal(page.html.includes('data-action="DELETE"'), false);
});
