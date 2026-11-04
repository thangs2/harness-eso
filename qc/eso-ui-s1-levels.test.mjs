import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UI_STATES, renderStateFrame, projectS1WorkOverview } from '../eso/core/src/ui-frames.mjs';
import { renderWorkOverviewPage } from '../eso/control-plane/src/modules/work-overview/application/work-overview.presenter.ts';

test('ESO-381: ST6_STALE is the stale state and no ST6_READY state exists', () => {
    assert.equal(UI_STATES.ST6_STALE, 'STALE');
    assert.equal(Object.prototype.hasOwnProperty.call(UI_STATES, 'ST6_READY'), false);
    assert.equal(UI_STATES.READY, 'READY');
    assert.throws(() => renderStateFrame({ state: 'ST6_READY' }), /Invalid UI state: ST6_READY/);
});

test('ESO-381: ST4_DENIED message is distinct from emptyMessage both when hideExistence is true and false', () => {
    const emptyFrame = renderStateFrame({
        state: UI_STATES.ST1_EMPTY,
        emptyMessage: 'chưa có dữ liệu nào',
    });
    const deniedNormal = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: false,
        emptyMessage: 'chưa có dữ liệu nào',
    });
    const deniedHidden = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: true,
        emptyMessage: 'chưa có dữ liệu nào',
    });
    assert.equal(deniedNormal.state, UI_STATES.ST4_DENIED);
    assert.equal(deniedNormal.message, 'Không có quyền truy cập');
    assert.notEqual(deniedNormal.message, emptyFrame.message);

    assert.equal(deniedHidden.state, UI_STATES.ST4_DENIED);
    assert.equal(deniedHidden.message, 'Không có quyền truy cập hoặc dự án không tồn tại');
    assert.notEqual(deniedHidden.message, emptyFrame.message);
});

test('ESO-381: ST5_PARTIAL completeness does not fallback to hardcoded 0.62', () => {
    const partialWithoutCompleteness = renderStateFrame({
        state: UI_STATES.ST5_PARTIAL,
        data: {},
    });
    assert.equal(partialWithoutCompleteness.completeness, null);
    assert.notEqual(partialWithoutCompleteness.completeness, 0.62);

    const partialNullData = renderStateFrame({
        state: UI_STATES.ST5_PARTIAL,
        data: null,
    });
    assert.equal(partialNullData.completeness, null);
    assert.notEqual(partialNullData.completeness, 0.62);

    const partialWithCompleteness = renderStateFrame({
        state: UI_STATES.ST5_PARTIAL,
        data: { completeness: 0.45 },
    });
    assert.equal(partialWithCompleteness.completeness, 0.45);
});

test('AC-UI-01-12: a cannot-judge row and an insufficient row render differently', () => {
    const overview = projectS1WorkOverview({
        project: 'p1',
        turns: [
            { turn_id: 't-cannot', work: 'xác minh RLS', level: 'cannot-judge' },
            { turn_id: 't-insufficient', work: 'thêm endpoint', level: 'insufficient' },
        ],
    });

    const cannot = overview.rows.find((r) => r.turn_id === 't-cannot');
    const insufficient = overview.rows.find((r) => r.turn_id === 't-insufficient');

    // AC-UI-01-12: two levels, two forms — an agent that merges them into one
    // badge makes the row read "không biết" as "không đủ".
    assert.equal(cannot.level, 'cannot-judge');
    assert.equal(insufficient.level, 'insufficient');
    assert.equal(cannot.distinct_styling, 'border-dashed');
    assert.equal(insufficient.distinct_styling, 'border-solid-red');
    assert.notEqual(cannot.distinct_styling, insufficient.distinct_styling);

    // The same difference must survive into the rendered page, not just the
    // projection object.
    const page = renderWorkOverviewPage({
        project: 'p1',
        turns: [
            { turn_id: 't-cannot', work: 'xác minh RLS', level: 'cannot-judge' },
            { turn_id: 't-insufficient', work: 'thêm endpoint', level: 'insufficient' },
        ],
    });
    const rowOf = (id) => page.html.match(new RegExp(`<tr data-turn-id="${id}"[\\s\\S]*?</tr>`))[0];
    assert.match(rowOf('t-cannot'), /data-level="cannot-judge"/);
    assert.match(rowOf('t-insufficient'), /data-level="insufficient"/);
    assert.equal(
        rowOf('t-cannot').match(/class="([^"]*)"/)[1],
        'border-dashed'
    );
    assert.equal(
        rowOf('t-insufficient').match(/class="([^"]*)"/)[1],
        'border-solid-red'
    );
});
