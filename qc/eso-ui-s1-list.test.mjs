import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('AC-UI-01-07: S1 renders list of 3 turns sorted newest first with work, level, missing count', () => {
    const turns = [
        { turn_id: 't-old', work: 'w1', level: 'sufficient', created_at: '2026-11-01T10:00:00Z' },
        { turn_id: 't-newest', work: 'w3', level: 'partial', missing: ['m1'], created_at: '2026-11-03T10:00:00Z' },
        { turn_id: 't-mid', work: 'w2', level: 'sufficient', created_at: '2026-11-02T10:00:00Z' },
    ];
    const page = renderWorkOverviewPage({ project: 'p1', turns });
    assert.equal(page.state, 'READY');
    assert.equal(page.overview.rows.length, 3);
    assert.equal(page.overview.rows[0].turn_id, 't-newest');
    assert.equal(page.overview.rows[1].turn_id, 't-mid');
    assert.equal(page.overview.rows[2].turn_id, 't-old');

    // The row shows the work name, its level and its own missing count — on the
    // same row, newest first.
    const newestRow = page.html.match(/<tr data-turn-id="t-newest"[\s\S]*?<\/tr>/)[0];
    assert.match(newestRow, /<td class="col-work">w3<\/td>/);
    assert.match(newestRow, /<td class="col-level">partial<\/td>/);
    assert.match(newestRow, /⚠ 1 thiếu/);
    assert.match(page.html, /<td class="col-work">w1<\/td>/);
    assert.match(page.html, /<td class="col-work">w2<\/td>/);
});

test('AC-UI-01-07: the work column shows the recorded work of an evidence_turn row, not an empty cell', () => {
    // The S1 page is fed by EvidenceRepository.list(): one row per
    // evidence_turn, carrying the turn payload recorded by the host hook
    // (`payload: turnData.payload || turnData`). The work name lives in that
    // payload — the route must surface it verbatim.
    const evidenceRows = [
        {
            project: 'p1',
            turn_id: 'turn-nest-1',
            at: '2026-11-03T10:00:00Z',
            actor_role: 'lead',
            actor_status: 'FULL',
            level: 'partial',
            mode: 'do',
            basis: 'verified',
            rule_version: '2.0.0',
            payload: { work: 'sửa cột tenants', missing: ['m1', 'm2'] },
        },
    ];

    const page = renderWorkOverviewPage({ project: 'p1', turns: evidenceRows });
    const row = page.html.match(/<tr data-turn-id="turn-nest-1"[\s\S]*?<\/tr>/)[0];

    assert.match(row, /<td class="col-work">sửa cột tenants<\/td>/);
    assert.equal(row.includes('<td class="col-work"></td>'), false, 'work cell must not be empty');
    assert.equal(row.includes('<td class="col-work">chưa ghi</td>'), false, 'a recorded work is not "chưa ghi"');
    assert.match(row, /⚠ 2 thiếu/);

    // DB columns win over payload copies: the closed-vocabulary level recorded
    // in the column is what the row shows.
    assert.equal(page.overview.rows[0].level, 'partial');
});
