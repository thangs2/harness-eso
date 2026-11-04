/**
 * @mu/eso-core — UI Reading Frames & S1..S5 Surface Projections
 *
 * Covers:
 * - 7.1 / ESO-216: Generic ST1..ST6 state render frames (Empty, Loading, Failed, Denied, Partial, Ready)
 * - US-UI-01 / ESO-217: S1 Work overview (newest first, completeness, warnings, read-only)
 * - US-UI-02 / ESO-218: S2 Why & Unknowns (4 parts, rule version, no-infer)
 * - US-UI-03 / ESO-219: S3 Configuration safety (disabled save until preview, hash check, multi-project impact)
 * - US-UI-04 / ESO-220: S4 Debt lifecycle (required reason, immutable history, folded closed debts, tenant isolation)
 * - US-UI-05 / ESO-221: S5 Artefact reconstruction (turn, hash, reverted skill flag, dirty content notice, pagination)
 */

/**
 * The six UX states are a closed set (sdlc/08.ui-design/03.states.md §1):
 * ST1 empty · ST2 loading · ST3 error · ST4 denied · ST5 partial · ST6 stale.
 *
 * ST6 means **stale only**. A surface with recorded data and enough coverage is
 * not a seventh state — it is `READY`, the content branch. Keeping `ST6_READY`
 * made every ready surface claim the stale state, so all `AC-UI-0x-06` frames
 * could never appear.
 */
export const UI_STATES = Object.freeze({
    ST1_EMPTY: 'EMPTY',
    ST2_LOADING: 'LOADING',
    ST3_FAILED: 'FAILED',
    ST4_DENIED: 'DENIED',
    ST5_PARTIAL: 'PARTIAL',
    ST6_STALE: 'STALE',
    READY: 'READY',
});

// ----------------------------------------------------
// 7.1 / ESO-216: Generic State Render Frame
// ----------------------------------------------------

/**
 * The two causes of ST4 denial a caller may hold. They are the two halves of the
 * one refusal sentence the surface may render while existence is hidden
 * (sdlc/08.ui-design/03.states.md §2: "hai ca này **một** câu, vì phân biệt
 * chúng là tiết lộ").
 */
export const DENIAL_REASONS = Object.freeze({
    NOT_FOUND: 'not-found',
    NO_PERMISSION: 'no-permission',
});

const DENIAL_REASON_SET = new Set(Object.values(DENIAL_REASONS));

export function renderStateFrame({
    state,
    data = null,
    error = null,
    emptyMessage = 'chưa có dữ liệu nào',
    hideExistence = false,
    reason = null,
} = {}) {
    switch (state) {
        case UI_STATES.ST1_EMPTY:
            return {
                state: UI_STATES.ST1_EMPTY,
                rendered: true,
                content: null,
                message: emptyMessage,
                actions: ['CHANGE_PROJECT'],
            };
        case UI_STATES.ST2_LOADING:
            return {
                state: UI_STATES.ST2_LOADING,
                rendered: true,
                skeleton: { blocks: 4 },
                buttons_disabled: true,
                // ESO-379: this used to be the literal `1`. The frame has no
                // request source, so a number here claimed a measurement nobody
                // took. Unrecorded is `null`, like ST6 coverage and ST5
                // completeness; a recorded count passes through unchanged.
                active_requests: data && Number.isInteger(data.active_requests) ? data.active_requests : null,
            };
        case UI_STATES.ST3_FAILED:
            return {
                state: UI_STATES.ST3_FAILED,
                rendered: true,
                error: error || 'Hỏng kết nối hoặc lỗi dịch vụ',
                actions: ['RETRY'],
            };
        case UI_STATES.ST4_DENIED: {
            // ESO-379: the renderer used to ignore `reason`, so a not-found and a
            // no-permission frame were the same object and the equality test was
            // guaranteed by the signature. It now reads the reason, but the
            // security rule decides what it may say:
            //   hideExistence  → one sentence and one frame for both causes, reason
            //                    dropped, because a difference here discloses existence;
            //   disclosure     → the reason is kept and the sentence splits into the
            //                    two halves the hidden sentence already joins.
            if (hideExistence) {
                return {
                    state: UI_STATES.ST4_DENIED,
                    rendered: true,
                    message: 'Không có quyền truy cập hoặc dự án không tồn tại',
                    reason: null,
                    actions: ['CHANGE_PROJECT'],
                };
            }
            const disclosedReason = DENIAL_REASON_SET.has(reason) ? reason : null;
            return {
                state: UI_STATES.ST4_DENIED,
                rendered: true,
                message: disclosedReason === DENIAL_REASONS.NOT_FOUND
                    ? 'Dự án không tồn tại'
                    : 'Không có quyền truy cập',
                reason: disclosedReason,
                actions: ['CHANGE_PROJECT'],
            };
        }
        case UI_STATES.ST5_PARTIAL:
            return {
                state: UI_STATES.ST5_PARTIAL,
                rendered: true,
                content: data,
                warning: 'Dữ liệu chưa hoàn chỉnh',
                completeness: (data && data.completeness !== undefined) ? data.completeness : null,
            };
        case UI_STATES.ST6_STALE:
            return {
                state: UI_STATES.ST6_STALE,
                rendered: true,
                content: data,
                stale: true,
                // AC-UI-01-06: the coverage ratio is DATA. When the caller has
                // none, the frame says nothing about it instead of inventing a
                // number — a made-up ratio is false certainty on a warning.
                coverage: (data && data.coverage !== undefined) ? data.coverage : null,
            };
        case UI_STATES.READY:
            return {
                state: UI_STATES.READY,
                rendered: true,
                content: data,
            };
        default:
            throw new Error(`Invalid UI state: ${state}`);
    }
}

// ----------------------------------------------------
// US-UI-01 / ESO-217: S1 Work Overview Surface
// ----------------------------------------------------

export function projectS1WorkOverview({
    project,
    hasAccess = true,
    turns = [],
} = {}) {
    // AC-UI-01-04: Non-accessible project renders identical to non-existent project (ST4 hidden)
    if (!hasAccess) {
        return renderStateFrame({
            state: UI_STATES.ST4_DENIED,
            hideExistence: true,
            emptyMessage: 'chưa có turn nào',
        });
    }

    // AC-UI-01-01 / ED1: 0 turns
    if (!Array.isArray(turns) || turns.length === 0) {
        return renderStateFrame({
            state: UI_STATES.ST1_EMPTY,
            emptyMessage: 'chưa có turn nào',
        });
    }

    // AC-UI-01-07: Sorted newest first, lists level and missing count
    const sortedTurns = [...turns].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const rows = sortedTurns.map((t) => {
        const isPartial = t.level === 'partial' || (t.missing && t.missing.length > 0);
        // AC-UI-01-06: an unrecorded ratio stays `null`; defaulting it to 1.0
        // would print "complete" for a turn nobody measured.
        const completeness = (t.completeness === undefined || t.completeness === null) ? null : t.completeness;

        return {
            turn_id: t.turn_id,
            work: t.work || t.task,
            // AC-UI-01-12: an unrecorded level stays `null` — `sufficient` is a
            // verdict, and the surface must never invent one.
            level: t.level === undefined || t.level === null ? null : t.level,
            missing_count: (t.missing && t.missing.length) || 0,
            missing_badge: isPartial ? `⚠ ${(t.missing && t.missing.length) || 0} thiếu` : null, // AC-UI-01-05
            completeness_bar: completeness !== null && completeness < 0.70 ? { warning: true, ratio: completeness } : null, // AC-UI-01-06
            distinct_styling: t.level === 'cannot-judge' ? 'border-dashed' : (t.level === 'insufficient' ? 'border-solid-red' : 'border-normal'), // AC-UI-01-12
            actions: ['WHY'], // AC-UI-01-08: [Vì sao] button opens S2
        };
    });

    return {
        state: UI_STATES.READY,
        project,
        total_turns: rows.length,
        has_write_buttons: false, // AC-UI-01-11: Read-only, 0 write buttons
        rows,
    };
}

// ----------------------------------------------------
// US-UI-02 / ESO-218: S2 Why & Unknowns Surface
// ----------------------------------------------------

export function projectS2WhyDetails({
    turn,
    currentRuleVersion = 4,
} = {}) {
    // AC-UI-02-01 / ED1: Missing turn record
    if (!turn || !turn.record) {
        return {
            state: UI_STATES.ST1_EMPTY,
            message: 'không có bản ghi',
            can_reconstruct: false,
        };
    }

    const rec = turn.record;
    const ruleVersion = rec.rule_version || 1;
    const isOldRule = ruleVersion < currentRuleVersion;

    const unknowns = Array.isArray(rec.unknowns) ? rec.unknowns : [];

    // AC-UI-02-07: 4 parts in order: verdict, evidence, basis, unknowns
    return {
        state: UI_STATES.READY,
        turn_id: turn.turn_id,
        rule_version_banner: isOldRule ? `theo luật cũ (v${ruleVersion})` : null, // AC-UI-02-06
        four_parts: {
            part_1_verdict: rec.verdict || 'cannot-judge',
            part_2_evidence: rec.evidence || [],
            part_3_basis: rec.basis || 'declared',
            part_4_unknowns: unknowns.length > 0 ? unknowns : 'không có gì chưa biết', // AC-UI-02-09
        },
        old_record_missing_field: !rec.previous_verdict ? 'không có mục này' : null, // AC-UI-02-05
        back_action: 'BACK_TO_S1', // AC-UI-02-10: preserves S1 selection
    };
}

// ----------------------------------------------------
// US-UI-03 / ESO-219: S3 Configuration Safety Surface
// ----------------------------------------------------

export function projectS3Configuration({
    config,
    pendingChanges = null,
    preview = null,
} = {}) {
    // AC-UI-03-07: Save button disabled until previewed
    const canSave = preview && preview.preview_hash && pendingChanges;

    return {
        state: UI_STATES.READY,
        current_config: config,
        save_button_enabled: Boolean(canSave),
        preview_hash: preview ? preview.preview_hash : null,
        impact_projects_count: (preview && preview.impact && preview.impact.length) || 0, // AC-UI-03-13
    };
}

// ----------------------------------------------------
// US-UI-04 / ESO-220: S4 Debt Management Surface
// ----------------------------------------------------

export function projectS4DebtList({
    project,
    debts = [],
    actorRole = 'operator',
} = {}) {
    // AC-UI-04-12: Tenant isolation
    const projectDebts = debts.filter((d) => d.project === project);

    const openDebts = projectDebts.filter((d) => d.status !== 'closed');
    const closedDebts = projectDebts.filter((d) => d.status === 'closed');

    // AC-UI-04-01 / ED1: 0 open debts
    if (openDebts.length === 0) {
        return {
            state: UI_STATES.ST1_EMPTY,
            message: 'không có nợ nào đang mở',
            closed_debts_count: closedDebts.length,
            can_close: false,
        };
    }

    const isOperator = actorRole === 'operator' || actorRole === 'admin';

    const items = openDebts.map((d) => {
        const ageDays = d.age_days || 1;
        const isOverdue = d.overdue_days && d.overdue_days > 0;
        return {
            id: d.id,
            kind: d.kind,
            age_days: ageDays,
            overdue_label: isOverdue ? `quá hạn ${d.overdue_days} ngày` : null, // AC-UI-04-07
            affected_artefact: d.artefact_id ? `⚠ ${d.artefact_id}` : null,
        };
    });

    return {
        state: UI_STATES.READY,
        project,
        open_items: items,
        closed_items_folded: closedDebts, // AC-UI-04-05: Preserved folded under ĐÃ ĐÓNG
        can_close: isOperator, // AC-UI-04-04: Non-operator has NO close button
    };
}

export function closeDebtWithReason({
    debtId,
    reason,
    actor = 'operator',
    debts = [],
} = {}) {
    // AC-UI-04-09: Empty reason is blocked
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
        const err = new Error('REASON_REQUIRED: Closing debt requires mandatory reason');
        err.code = 'REASON_REQUIRED';
        throw err;
    }

    const debt = debts.find((d) => d.id === debtId);
    if (!debt) throw new Error(`Debt '${debtId}' not found`);

    const now = new Date().toISOString();

    // AC-UI-04-10 & AC-UI-04-11: Appends closed event, original fields immutable, moved to closed group
    return {
        ...debt,
        status: 'closed',
        closed_at: now,
        closed_by: actor,
        close_reason: reason.trim(),
        events: [
            ...(debt.events || []),
            { event: 'closed', by: actor, reason: reason.trim(), at: now },
        ],
    };
}

// ----------------------------------------------------
// US-UI-05 / ESO-221: S5 Artefact Reconstruction Surface
// ----------------------------------------------------

export function projectS5ArtefactReconstruct({
    artefactId,
    hasAccess = true,
    record = null,
    isRevertedSkill = false,
    fileIsDirty = false,
    page = 1,
    pageSize = 50,
} = {}) {
    // AC-UI-05-04 & AC-UI-05-12: Non-accessible or invalid ID matches ST1 message
    if (!hasAccess || !record) {
        return {
            state: UI_STATES.ST1_EMPTY,
            message: 'không có bản ghi',
            actions: ['BACK_TO_DEBT'],
        };
    }

    const turnsCount = record.turns_used ? record.turns_used.length : 1;
    const startIndex = (page - 1) * pageSize;
    const paginatedTurns = record.turns_used ? record.turns_used.slice(startIndex, startIndex + pageSize) : [];

    return {
        state: UI_STATES.READY,
        artefact_id: artefactId,
        turn_id: record.turn_id,
        file_hash: fileIsDirty ? null : record.file_hash,
        content_notice: fileIsDirty ? 'không lấy lại được nội dung' : null, // AC-UI-05-08
        reverted_skill_banner: isRevertedSkill ? 'đã chạy trên bản bị revert' : null, // AC-UI-05-06
        missing_field_notice: !record.manifest ? 'không có mục này' : null, // AC-UI-05-05
        has_write_buttons: false, // AC-UI-05-10: Read-only, 0 write buttons
        pagination: { // AC-UI-05-09
            page,
            page_size: pageSize,
            total_turns: turnsCount,
            items: paginatedTurns,
        },
    };
}
