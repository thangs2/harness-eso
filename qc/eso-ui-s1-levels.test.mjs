import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UI_STATES, renderStateFrame } from '../eso/core/src/ui-frames.mjs';

test('ESO-381: UI_STATES.ST6_STALE === "STALE"', () => {
    assert.equal(UI_STATES.ST6_STALE, 'STALE');
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
