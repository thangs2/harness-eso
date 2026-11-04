import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ASSURANCE_LEVELS,
    validateHostManifest,
    createHostAdapter,
    UI_STATES,
    renderStateFrame,
    projectS1WorkOverview,
    projectS2WhyDetails,
    projectS3Configuration,
    projectS4DebtList,
    closeDebtWithReason,
    projectS5ArtefactReconstruct,
} from '../eso/core/src/index.mjs';

// ==========================================
// WP 8.1 / ESO-227: Host Contract & Adapters
// ==========================================

test('SCN-HOST-01 (DoD 8.1): Exactly 3 assurance levels and rejects invalid level or missing capability', () => {
    assert.deepEqual(ASSURANCE_LEVELS, ['NATIVE', 'EMULATED', 'UNAVAILABLE']);
    assert.equal(ASSURANCE_LEVELS.length, 3);

    // Three concrete adapters
    const cursor = createHostAdapter('cursor');
    const agy = createHostAdapter('antigravity');
    const dsh = createHostAdapter('deepseek-harness');

    assert.equal(cursor.manifest.capabilities.codegraph_query, 'NATIVE');
    assert.equal(agy.manifest.capabilities.codegraph_query, 'EMULATED');
    assert.equal(dsh.manifest.capabilities.codegraph_query, 'UNAVAILABLE');

    // Reject missing capability
    assert.throws(() => {
        validateHostManifest({
            host_id: 'bad-host',
            capabilities: { file_tools: 'NATIVE' }, // missing other required capabilities
        });
    }, (err) => {
        assert.equal(err.code, 'INVALID_HOST_MANIFEST');
        return true;
    });

    // Reject 4th assurance level
    assert.throws(() => {
        validateHostManifest({
            host_id: 'bad-level',
            capabilities: {
                file_tools: 'EXPERIMENTAL', // invalid level
                shell_commands: 'NATIVE',
                subagents: 'NATIVE',
                codegraph_query: 'NATIVE',
                agentmemory_query: 'NATIVE',
                deepseek_direct: 'NATIVE',
            },
        });
    }, (err) => {
        assert.equal(err.code, 'INVALID_ASSURANCE_LEVEL');
        return true;
    });
});

// ==========================================
// WP 7.1 / ESO-216: Generic ST1..ST6 Frames
// ==========================================

test('SCN-UI-FRAME-01 (DoD 7.1): ST4 hides existence while a refusal is hidden and distinguishes not-found from no-permission once disclosure is allowed', () => {
    const emptyFrame = renderStateFrame({
        state: UI_STATES.ST1_EMPTY,
        emptyMessage: 'chưa có dữ liệu nào',
    });
    assert.equal(emptyFrame.state, 'EMPTY');
    assert.equal(emptyFrame.message, 'chưa có dữ liệu nào');

    // sdlc/08.ui-design/03.states.md §2: while existence is hidden the refusal must be the same sentence for
    // "not found" and "no permission" — telling the two apart discloses existence by negation. The whole frame is
    // identical, so the equality is a decision about the reason, not an accident of the renderer's signature.
    const deniedNotFound = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: true,
        reason: 'not-found',
    });
    const deniedNoPermission = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: true,
        reason: 'no-permission',
    });
    assert.equal(deniedNotFound.state, 'DENIED');
    assert.equal(deniedNoPermission.state, 'DENIED');
    assert.equal(deniedNotFound.message, deniedNoPermission.message);
    assert.equal(deniedNotFound.message, 'Không có quyền truy cập hoặc dự án không tồn tại');
    assert.notEqual(deniedNotFound.message, emptyFrame.message);
    assert.deepEqual(deniedNotFound, deniedNoPermission);
    assert.equal(deniedNotFound.reason, null);

    // ESO-379: once the caller allows disclosure, ignoring `reason` is the bug — the two causes must be distinct in
    // the frame data and in the copy. The two sentences are the halves the hidden sentence already joins.
    const disclosedNotFound = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: false,
        reason: 'not-found',
    });
    const disclosedNoPermission = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: false,
        reason: 'no-permission',
    });
    assert.equal(disclosedNotFound.reason, 'not-found');
    assert.equal(disclosedNoPermission.reason, 'no-permission');
    assert.notEqual(disclosedNotFound.message, disclosedNoPermission.message);
    assert.equal(disclosedNotFound.message, 'Dự án không tồn tại');
    assert.equal(disclosedNoPermission.message, 'Không có quyền truy cập');
    // An unrecorded or unknown reason never invents a distinction: the generic refusal and a null reason.
    const disclosedUnknown = renderStateFrame({
        state: UI_STATES.ST4_DENIED,
        hideExistence: false,
        reason: 'rate-limited',
    });
    assert.equal(disclosedUnknown.reason, null);
    assert.equal(disclosedUnknown.message, 'Không có quyền truy cập');

    // Loading skeleton. The request count is DATA, not a constant (ESO-379): a frame with no request source used to
    // report exactly 1, which asserted a measurement nobody took. Unrecorded stays null; a recorded count is passed
    // through as-is.
    const loadingFrame = renderStateFrame({ state: UI_STATES.ST2_LOADING });
    assert.equal(loadingFrame.buttons_disabled, true);
    assert.equal(loadingFrame.active_requests, null);
    const loadingWithRequests = renderStateFrame({ state: UI_STATES.ST2_LOADING, data: { active_requests: 2 } });
    assert.equal(loadingWithRequests.active_requests, 2);
});

// ==========================================
// US-UI-01 / ESO-217: S1 Work Overview
// ==========================================

test('SCN-UI-01 (AC-UI-01-01..12): S1 work overview sorted newest first, read-only, handles partial badges and completeness', () => {
    const turns = [
        { turn_id: 't-1', work: 'task 1', level: 'sufficient', created_at: '2026-11-04T00:00:00Z', completeness: 1.0 },
        { turn_id: 't-2', work: 'task 2', level: 'partial', missing: ['m1', 'm2'], created_at: '2026-11-04T01:00:00Z', completeness: 0.62 },
    ];

    const s1 = projectS1WorkOverview({
        project: 'baplatform',
        turns,
    });

    assert.equal(s1.has_write_buttons, false); // AC-UI-01-11
    assert.equal(s1.rows.length, 2);
    // Newest first (t-2 before t-1)
    assert.equal(s1.rows[0].turn_id, 't-2');
    assert.equal(s1.rows[0].missing_badge, '⚠ 2 thiếu'); // AC-UI-01-05
    assert.ok(s1.rows[0].completeness_bar); // AC-UI-01-06

    // Empty project
    const emptyS1 = projectS1WorkOverview({ project: 'empty-proj', turns: [] });
    assert.equal(emptyS1.state, 'EMPTY');

    // Unauthorized project
    const unauthorizedS1 = projectS1WorkOverview({ project: 'secret-proj', hasAccess: false });
    assert.equal(unauthorizedS1.state, 'DENIED');
    assert.notEqual(unauthorizedS1.message, emptyS1.message);
});

// ==========================================
// US-UI-02 / ESO-218: S2 Why & Unknowns
// ==========================================

test('SCN-UI-02 (AC-UI-02-01..10): S2 Why details renders 4 parts, old rule banner, and empty unknowns', () => {
    const turn = {
        turn_id: 'turn-99',
        record: {
            verdict: 'sufficient',
            evidence: ['ev-1'],
            basis: 'codebase',
            unknowns: [],
            rule_version: 3, // older than current 4
            previous_verdict: null,
        },
    };

    const s2 = projectS2WhyDetails({
        turn,
        currentRuleVersion: 4,
    });

    assert.equal(s2.state, 'READY');
    assert.equal(s2.rule_version_banner, 'theo luật cũ (v3)'); // AC-UI-02-06
    assert.equal(s2.four_parts.part_4_unknowns, 'không có gì chưa biết'); // AC-UI-02-09
    assert.equal(s2.old_record_missing_field, 'không có mục này'); // AC-UI-02-05
});

// ==========================================
// US-UI-03 / ESO-219: S3 Configuration Safety
// ==========================================

test('SCN-UI-03 (AC-UI-03-07..13): S3 configuration disables save until previewed with impact', () => {
    const unpreviewed = projectS3Configuration({
        config: { version: 1 },
        pendingChanges: { key: 'val' },
        preview: null,
    });
    assert.equal(unpreviewed.save_button_enabled, false); // AC-UI-03-07

    const previewed = projectS3Configuration({
        config: { version: 1 },
        pendingChanges: { key: 'val' },
        preview: {
            preview_hash: 'hash-abc',
            impact: Array.from({ length: 50 }),
        },
    });
    assert.equal(previewed.save_button_enabled, true);
    assert.equal(previewed.impact_projects_count, 50); // AC-UI-03-13
});

// ==========================================
// US-UI-04 / ESO-220: S4 Debt Lifecycle
// ==========================================

test('SCN-UI-04 (AC-UI-04-01..12): S4 debt list requires reason, preserves folded closed debts, isolates tenant', () => {
    const debts = [
        { id: 'd-1', project: 'baplatform', kind: 'tech_debt', status: 'open', age_days: 10, overdue_days: 3, artefact_id: 'art-10' },
        { id: 'd-2', project: 'baplatform', kind: 'lint', status: 'closed' },
        { id: 'd-other', project: 'other-proj', kind: 'tech_debt', status: 'open' },
    ];

    const s4 = projectS4DebtList({
        project: 'baplatform',
        debts,
        actorRole: 'operator',
    });

    assert.equal(s4.open_items.length, 1);
    assert.equal(s4.open_items[0].overdue_label, 'quá hạn 3 ngày'); // AC-UI-04-07
    assert.equal(s4.closed_items_folded.length, 1); // AC-UI-04-05
    assert.equal(s4.can_close, true);

    // Non-operator cannot close (AC-UI-04-04)
    const readOnlyS4 = projectS4DebtList({ project: 'baplatform', debts, actorRole: 'viewer' });
    assert.equal(readOnlyS4.can_close, false);

    // Close without reason throws REASON_REQUIRED (AC-UI-04-09)
    assert.throws(() => {
        closeDebtWithReason({
            debtId: 'd-1',
            reason: '', // empty
            debts,
        });
    }, (err) => {
        assert.equal(err.code, 'REASON_REQUIRED');
        return true;
    });

    // Close with reason appends closed event and updates status (AC-UI-04-10)
    const closed = closeDebtWithReason({
        debtId: 'd-1',
        reason: 'Refactored to v2 standard',
        actor: 'operator-thang',
        debts,
    });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.close_reason, 'Refactored to v2 standard');
    assert.equal(closed.events[0].event, 'closed');
});

// ==========================================
// US-UI-05 / ESO-221: S5 Artefact Reconstruction
// ==========================================

test('SCN-UI-05 (AC-UI-05-01..12): S5 artefact reconstruct handles dirty files, reverted skill banner, pagination, read-only', () => {
    const record = {
        turn_id: 'turn-88',
        file_hash: 'sha256-abc123',
        turns_used: Array.from({ length: 120 }, (_, i) => `turn-${i + 1}`),
    };

    const s5 = projectS5ArtefactReconstruct({
        artefactId: 'art-88',
        record,
        isRevertedSkill: true, // AC-UI-05-06
        fileIsDirty: true,     // AC-UI-05-08
        page: 2,
        pageSize: 50,
    });

    assert.equal(s5.state, 'READY');
    assert.equal(s5.reverted_skill_banner, 'đã chạy trên bản bị revert');
    assert.equal(s5.content_notice, 'không lấy lại được nội dung');
    assert.equal(s5.has_write_buttons, false); // AC-UI-05-10
    assert.equal(s5.pagination.total_turns, 120);
    assert.equal(s5.pagination.items.length, 50); // AC-UI-05-09
});
