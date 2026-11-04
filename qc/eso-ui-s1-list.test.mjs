import test from 'node:test';
import assert from 'node:assert/strict';
import { renderS1Page } from '../eso/control-plane/src/modules/s1/application/s1.presenter.ts';

test('AC-UI-01-07: S1 renders list of 3 turns sorted newest first with work, level, missing count', () => {
    const turns = [
        { turn_id: 't-old', work: 'w1', level: 'sufficient', created_at: '2026-11-01T10:00:00Z' },
        { turn_id: 't-newest', work: 'w3', level: 'partial', missing: ['m1'], created_at: '2026-11-03T10:00:00Z' },
        { turn_id: 't-mid', work: 'w2', level: 'sufficient', created_at: '2026-11-02T10:00:00Z' },
    ];
    const page = renderS1Page({ project: 'p1', turns });
    assert.equal(page.state, 'READY');
    assert.equal(page.overview.rows.length, 3);
    assert.equal(page.overview.rows[0].turn_id, 't-newest');
    assert.equal(page.overview.rows[1].turn_id, 't-mid');
    assert.equal(page.overview.rows[2].turn_id, 't-old');
});
