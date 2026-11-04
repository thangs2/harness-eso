import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
    S1WorkOverviewComponent,
    S1WorkOverviewClient,
    AuthService,
    S1WorkStore,
    S3ConfigPage,
    ControlPlaneApiClient,
} from '../eso/ui/src/index.mjs';

test('INV-UI-03 / D-74: eso/ui never imports code from v1 packages/harness-*', () => {
    const compFile = readFileSync(join(REPO_ROOT, 'eso/ui/src/app/modules/s1-work-overview/s1-work-overview.component.ts'), 'utf-8');
    const serviceFile = readFileSync(join(REPO_ROOT, 'eso/ui/src/app/modules/s1-work-overview/s1-work-overview.service.ts'), 'utf-8');

    assert.ok(!compFile.includes('packages/harness-'), 'Component must not import v1 packages');
    assert.ok(!serviceFile.includes('packages/harness-'), 'Service must not import v1 packages');
});

test('Angular Standard: structure check script validates all tier and boundary rules', () => {
    const output = execSync('node eso/ui/scripts/check-structure.mjs', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    assert.match(output, /Structure check passed/);
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

test('SKILL.md §7: AuthService manages token in memory without localStorage', () => {
    const auth = new AuthService();
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(auth.token(), null);

    auth.setToken('bearer-sample-test-token');
    assert.equal(auth.isAuthenticated(), true);
    assert.equal(auth.token(), 'bearer-sample-test-token');

    auth.clearToken();
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(auth.token(), null);
});

test('SKILL.md §3 & §5: S1WorkStore manages signal state and enforces read-only surface', () => {
    const store = new S1WorkStore();

    assert.equal(store.state(), 'ST2_LOADING');
    assert.equal(store.isReadOnly(), true);
    assert.equal(store.totalItems(), 0);

    store.setLoaded([
        {
            turnId: 'turn-1',
            work: 'Fix Auth Guard',
            level: 'sufficient',
            missingBadge: '0 thiếu',
            distinctStyling: 'style-success',
        },
    ]);

    assert.equal(store.state(), 'ST6_READY');
    assert.equal(store.totalItems(), 1);
    assert.equal(store.hasItems(), true);

    store.setFailed('Lỗi kết nối máy chủ');
    assert.equal(store.state(), 'ST3_FAILED');
    assert.equal(store.errorMessage(), 'Lỗi kết nối máy chủ');

    store.setDenied();
    assert.equal(store.state(), 'ST4_DENIED');
});

test('SKILL.md §5: S3ConfigPage enforces save disabled until preview exists and handles conflict', () => {
    const page = new S3ConfigPage();

    assert.equal(page.hasPreview(), false);
    assert.equal(page.canSave(), false);

    page.generatePreview();
    assert.equal(page.hasPreview(), true);
    assert.equal(page.canSave(), true);
    assert.ok(page.preview()?.hash.startsWith('cfg-'));

    page.conflictError.set(true);
    assert.equal(page.conflictError(), true);

    page.generatePreview();
    assert.equal(page.conflictError(), false);
});
