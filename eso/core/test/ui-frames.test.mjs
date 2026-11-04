import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    UI_STATES,
    renderStateFrame,
    projectS1WorkOverview,
} from '../src/ui-frames.mjs';

// ---------------------------------------------------------------------------
// ESO-381 — ST6 is the stale state, and only the stale state.
// sdlc/08.ui-design/03.states.md §1: ST1 empty · ST2 loading · ST3 error ·
// ST4 denied · ST5 partial · ST6 stale — six states, closed set.
// ---------------------------------------------------------------------------

test('ESO-381: ST6 means stale only — there is no ST6_READY state', () => {
    assert.equal(UI_STATES.ST6_STALE, 'STALE');
    assert.equal(Object.prototype.hasOwnProperty.call(UI_STATES, 'ST6_READY'), false);

    // A caller that still asks for the old name must fail loudly, not silently
    // render a ready surface under a stale label.
    assert.throws(
        () => renderStateFrame({ state: 'ST6_READY', data: { rows: [] } }),
        /Invalid UI state: ST6_READY/
    );
});

test('ESO-381: ready is READY — no stale flag; stale is STALE with the recorded ratio only', () => {
    const ready = renderStateFrame({ state: UI_STATES.READY, data: { rows: [1] } });
    assert.equal(ready.state, 'READY');
    assert.equal(ready.stale, undefined);

    const stale = renderStateFrame({ state: UI_STATES.ST6_STALE, data: { coverage: 0.62 } });
    assert.equal(stale.state, 'STALE');
    assert.equal(stale.stale, true);
    assert.equal(stale.coverage, 0.62);

    // AC-UI-01-06: no recorded ratio ⇒ the frame carries no number at all.
    // A fabricated ratio would be false certainty on a warning banner.
    const staleUnknown = renderStateFrame({ state: UI_STATES.ST6_STALE, data: {} });
    assert.equal(staleUnknown.coverage, null);
});

test('ESO-381: a ready S1 projection is not labelled stale and is not ST6_READY', () => {
    const view = projectS1WorkOverview({
        project: 'p1',
        turns: [{ turn_id: 't-1', work: 'sửa cột tenants', level: 'sufficient' }],
    });

    assert.equal(view.state, 'READY');
    assert.notEqual(view.state, 'ST6_STALE');
    assert.notEqual(view.state, 'ST6_READY');
    assert.equal(view.rows.length, 1);
});

// ---------------------------------------------------------------------------
// ESO-381 — denied must not render like empty.
// ---------------------------------------------------------------------------

test('ESO-381: ST4 denied renders differently from ST1 empty and never echoes the empty message', () => {
    const emptyMessage = 'chưa có turn nào';
    const empty = renderStateFrame({ state: UI_STATES.ST1_EMPTY, emptyMessage });
    const denied = renderStateFrame({ state: UI_STATES.ST4_DENIED, hideExistence: true, emptyMessage });

    assert.equal(empty.state, 'EMPTY');
    assert.equal(empty.message, emptyMessage);

    assert.equal(denied.state, 'DENIED');
    assert.notEqual(denied.state, empty.state);
    assert.notEqual(denied.message, empty.message);
    assert.notEqual(denied.message, emptyMessage);
});

test('ESO-381: the refusal sentence is identical for not-found and no-permission (0 disclosure)', () => {
    const notFound = renderStateFrame({ state: UI_STATES.ST4_DENIED, hideExistence: true });
    const noPermission = renderStateFrame({ state: UI_STATES.ST4_DENIED, hideExistence: true });

    assert.equal(notFound.message, noPermission.message);

    // S1 denial goes through the same single sentence as the generic frame, and
    // must not be the S1 empty sentence.
    const s1Denied = projectS1WorkOverview({ project: 'secret-proj', hasAccess: false });
    const s1Empty = projectS1WorkOverview({ project: 'empty-proj', turns: [] });
    assert.equal(s1Denied.state, 'DENIED');
    assert.equal(s1Denied.message, notFound.message);
    assert.notEqual(s1Denied.message, s1Empty.message);
});

// ---------------------------------------------------------------------------
// ESO-381 — no fixture values in product code.
// ---------------------------------------------------------------------------

test('ESO-381: ST5 partial completeness is the recorded value or null — never a fixture', () => {
    assert.equal(renderStateFrame({ state: UI_STATES.ST5_PARTIAL, data: {} }).completeness, null);
    assert.equal(renderStateFrame({ state: UI_STATES.ST5_PARTIAL, data: null }).completeness, null);

    const recorded = renderStateFrame({ state: UI_STATES.ST5_PARTIAL, data: { completeness: 0.45 } });
    assert.equal(recorded.completeness, 0.45);
});

test('ESO-381: S1 rows never invent a level or a completeness ratio', () => {
    const view = projectS1WorkOverview({
        project: 'p1',
        turns: [{ turn_id: 't-unmeasured' }],
    });
    const row = view.rows[0];

    // Unknown stays unknown: 'sufficient' would be a verdict nobody recorded,
    // and 1.0/0.62 would be a ratio nobody measured.
    assert.equal(row.level, null);
    assert.equal(row.completeness_bar, null);

    const measured = projectS1WorkOverview({
        project: 'p1',
        turns: [{ turn_id: 't-low', level: 'partial', completeness: 0.62 }],
    });
    assert.deepEqual(measured.rows[0].completeness_bar, { warning: true, ratio: 0.62 });
});

test('ESO-381: ui-frames.mjs carries no 0.62 fixture constant', () => {
    const source = readFileSync(new URL('../src/ui-frames.mjs', import.meta.url), 'utf-8');
    assert.equal(/\b0\.62\b/.test(source), false, 'fixture ratio 0.62 must not live in product code');
});
