// @ts-ignore - core domain is plain ESM during the migration
import { UI_STATES, renderStateFrame, projectS1WorkOverview } from '../../../../../core/src/ui-frames.mjs';

function escapeHtml(str: any) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * @mu/eso-control-plane — S1 Page Surface
 *
 * Implements S1 Work Overview (US-UI-01 / ESO-217 / ESO-380)
 */

export function renderS1Page({
    project = 'default',
    hasAccess = true,
    turns = [],
    isLoading = false,
    error = null,
    isStale = false,
}: any = {}) {
    if (isLoading) {
        const frame = renderStateFrame({ state: UI_STATES.ST2_LOADING });
        return {
            title: `S1 — Work Overview: ${project}`,
            state: UI_STATES.ST2_LOADING,
            frame,
            html: '<div class="s1-page loading"><div class="skeleton">Đang nạp dữ liệu...</div></div>',
            actions: [],
            buttons_disabled: true,
            active_requests: 1,
        };
    }

    if (error) {
        const frame = renderStateFrame({ state: UI_STATES.ST3_FAILED, error });
        return {
            title: `S1 — Work Overview: ${project}`,
            state: UI_STATES.ST3_FAILED,
            frame,
            html: `<div class="s1-page error"><div class="error-msg">${error}</div><button data-action="RETRY">Thử lại</button></div>`,
            actions: frame.actions,
            buttons_disabled: false,
        };
    }

    if (!hasAccess) {
        const frame = renderStateFrame({ state: UI_STATES.ST4_DENIED, hideExistence: true });
        return {
            title: 'S1 — Work Overview',
            state: UI_STATES.ST4_DENIED,
            frame,
            html: `<div class="s1-page denied"><div class="denied-msg">${frame.message}</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>`,
            actions: frame.actions,
            buttons_disabled: false,
        };
    }

    const safeProject = escapeHtml(project);
    if (!turns || turns.length === 0) {
        const frame = renderStateFrame({ state: UI_STATES.ST1_EMPTY, emptyMessage: 'chưa có turn nào' });
        return {
            title: `S1 — Work Overview: ${safeProject}`,
            state: UI_STATES.ST1_EMPTY,
            frame,
            html: '<div class="s1-page empty"><div class="empty-msg">chưa có turn nào</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>',
            actions: frame.actions,
            buttons_disabled: false,
        };
    }

    const overview = projectS1WorkOverview({ project, hasAccess, turns });
    const rows = overview.rows || [];
    const rowsHtml = rows
        .map(
            (r) =>
                `<tr data-turn-id="${escapeHtml(r.turn_id)}" class="${escapeHtml(r.distinct_styling)}"><td>${escapeHtml(r.work || '')}</td><td>${escapeHtml(r.level)}</td><td>${escapeHtml(r.missing_badge || '0 thiếu')}</td><td><button data-action="WHY" data-turn-id="${escapeHtml(r.turn_id)}">Vì sao</button></td></tr>`
        )
        .join('');

    return {
        title: `S1 — Work Overview: ${safeProject}`,
        state: isStale ? UI_STATES.ST6_STALE : UI_STATES.ST6_READY,
        overview,
        html: `<div class="s1-page ready"><h1>Dự án: ${safeProject}</h1><table class="turns-table"><thead><tr><th>Việc</th><th>Mức</th><th>Thiếu</th><th>Hành động</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
        actions: ['WHY'],
        has_write_buttons: false,
    };
}
