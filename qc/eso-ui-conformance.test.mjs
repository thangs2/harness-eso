import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import { S1WorkOverviewComponent, S1WorkOverviewClient } from '../eso/ui/src/index.mjs';

test('INV-UI-03 / D-74: eso/ui never imports code from v1 packages/harness-*', () => {
    const compFile = readFileSync(join(REPO_ROOT, 'eso/ui/src/app/modules/s1-work-overview/s1-work-overview.component.ts'), 'utf-8');
    const serviceFile = readFileSync(join(REPO_ROOT, 'eso/ui/src/app/modules/s1-work-overview/s1-work-overview.service.ts'), 'utf-8');

    assert.ok(!compFile.includes('packages/harness-'), 'Component must not import v1 packages');
    assert.ok(!serviceFile.includes('packages/harness-'), 'Service must not import v1 packages');
});

test('INV-UI-01 & INV-UI-02 / D-72: S1WorkOverviewComponent renders frames and dispatches actions without business logic', () => {
    const comp = new S1WorkOverviewComponent();

    // 1. Loading state (ST2_LOADING)
    comp.setState({ isLoading: true });
    const loadView = comp.renderView();
    assert.equal(loadView.state, 'ST2_LOADING');
    assert.match(loadView.html, /Đang nạp dữ liệu/);

    // 2. Error state (ST3_FAILED)
    comp.setState({ isLoading: false, error: 'Network timeout' });
    const errView = comp.renderView();
    assert.equal(errView.state, 'ST3_FAILED');
    assert.match(errView.html, /Network timeout/);
    assert.deepEqual(errView.actions, ['RETRY']);

    // 3. Denied state (ST4_DENIED)
    comp.setState({ error: null, hasAccess: false });
    const deniedView = comp.renderView();
    assert.equal(deniedView.state, 'ST4_DENIED');
    assert.deepEqual(deniedView.actions, ['CHANGE_PROJECT']);

    // 4. Empty state (ST1_EMPTY)
    comp.setState({ hasAccess: true, turns: [] });
    const emptyView = comp.renderView();
    assert.equal(emptyView.state, 'ST1_EMPTY');
    assert.match(emptyView.html, /chưa có turn nào/);
    assert.deepEqual(emptyView.actions, ['CHANGE_PROJECT']);

    // 5. Ready state (ST6_READY)
    comp.setState({
        project: 'baplatform',
        turns: [{ id: 't1' }],
        rows: [
            {
                turn_id: 'turn-999',
                work: 'Refactor Auth',
                level: 'sufficient',
                missing_badge: '0 thiếu',
                distinct_styling: 'style-success',
            },
        ],
    });
    const readyView = comp.renderView();
    assert.equal(readyView.state, 'ST6_READY');
    assert.match(readyView.html, /Dự án: baplatform/);
    assert.match(readyView.html, /data-turn-id="turn-999"/);
    assert.match(readyView.html, /Refactor Auth/);
    assert.deepEqual(readyView.actions, ['WHY']);

    // 6. Action emission
    let emittedAction = null;
    let emittedPayload = null;
    comp.onActionTriggered = (action, payload) => {
        emittedAction = action;
        emittedPayload = payload;
    };

    comp.triggerAction('WHY', { turn_id: 'turn-999' });
    assert.equal(emittedAction, 'WHY');
    assert.deepEqual(emittedPayload, { turn_id: 'turn-999' });
});
