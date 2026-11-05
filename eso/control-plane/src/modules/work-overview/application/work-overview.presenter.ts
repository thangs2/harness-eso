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
 * A turn row recorded in `evidence_turn` carries its own turn payload — the
 * host hook writes `payload: turnData.payload || turnData`. Flattening that
 * payload is what makes the S1 "Việc" column show the recorded work name:
 * `projectS1WorkOverview` reads `work`/`task`, and a raw evidence row has them
 * only inside `payload`. Recorded columns win over payload copies so a level
 * from the DB (closed vocabulary) is never replaced by a host-side string.
 */
function toS1Turn(row: any = {}) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    return {
        ...payload,
        ...row,
        turn_id: row.turn_id !== undefined ? row.turn_id : payload.turn_id,
        level: row.level !== undefined ? row.level : payload.level,
        created_at: row.created_at || row.at || payload.created_at,
    };
}

/** AC-UI-01-06: the coverage ratio is data; `0,62` is the documented example, never a constant. */
function formatCoverage(ratio: number | null | undefined): string | null {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    return String(Number(ratio.toFixed(2))).replace('.', ',');
}

/**
 * @mu/eso-control-plane — S1 Page Surface
 *
 * Implements S1 Work Overview (US-UI-01 / ESO-217 / ESO-380)
 */

export function renderWorkOverviewPage({
    project = 'default',
    hasAccess = true,
    turns = [],
    isLoading = false,
    error = null,
    isStale = false,
    coverage = null,
    activeRequests = null,
}: any = {}) {
    if (isLoading) {
        // Slice H (ESO-379 family): the request count is DATA. This used to be the literal `1`, which reported a
        // measurement nobody took; an unrecorded count is null. The frame is the single source, so the page cannot
        // disagree with the frame it carries.
        const recordedRequests = Number.isInteger(activeRequests) ? activeRequests : null;
        const frame = renderStateFrame({ state: UI_STATES.ST2_LOADING, data: { active_requests: recordedRequests } });
        return {
            title: `S1 — Work Overview: ${project}`,
            state: UI_STATES.ST2_LOADING,
            frame,
            html: '<div class="s1-page loading" data-state="ST2_LOADING"><div class="skeleton">Đang nạp dữ liệu...</div></div>',
            actions: [],
            buttons_disabled: true,
            active_requests: frame.active_requests,
        };
    }

    if (error) {
        const frame = renderStateFrame({ state: UI_STATES.ST3_FAILED, error });
        return {
            title: `S1 — Work Overview: ${project}`,
            state: UI_STATES.ST3_FAILED,
            frame,
            html: `<div class="s1-page error" data-state="ST3_FAILED"><div class="error-msg">${escapeHtml(error)}</div><button data-action="RETRY">Thử lại</button></div>`,
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
            html: `<div class="s1-page denied" data-state="ST4_DENIED"><div class="denied-msg">${escapeHtml(frame.message)}</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>`,
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
            html: '<div class="s1-page empty" data-state="ST1_EMPTY"><div class="empty-msg">chưa có turn nào</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>',
            actions: frame.actions,
            buttons_disabled: false,
        };
    }

    const overview = projectS1WorkOverview({ project, hasAccess, turns: turns.map(toS1Turn) });
    const rows = overview.rows || [];
    const rowsHtml = rows
        .map((r: any) => {
            // A missing work name renders as "chưa ghi", never as an
            // invisible cell and never as a fabricated label.
            const work = r.work === undefined || r.work === null || r.work === '' ? 'chưa ghi' : r.work;
            const level = r.level === null || r.level === undefined ? 'chưa ghi' : r.level;
            const missing = r.missing_badge === null || r.missing_badge === undefined ? '' : r.missing_badge;
            return `<tr data-turn-id="${escapeHtml(r.turn_id)}" data-level="${escapeHtml(level)}" class="${escapeHtml(r.distinct_styling)}"><td class="col-work">${escapeHtml(work)}</td><td class="col-level">${escapeHtml(level)}</td><td class="col-missing">${escapeHtml(missing)}</td><td><button data-action="WHY" data-turn-id="${escapeHtml(r.turn_id)}">Vì sao</button></td></tr>`;
        })
        .join('');

    const ratio = formatCoverage(coverage);
    const staleBanner = isStale
        ? `<div class="stale-banner" role="status">⚠ ${ratio ? `graph phủ ${ratio} — ` : ''}phán quyết có thể sai</div>`
        : '';

    return {
        title: `S1 — Work Overview: ${safeProject}`,
        state: isStale ? UI_STATES.ST6_STALE : UI_STATES.READY,
        overview,
        html: `<div class="s1-page ${isStale ? 'stale' : 'ready'}" data-state="${isStale ? 'ST6_STALE' : 'READY'}">${staleBanner}<h1>Dự án: ${safeProject}</h1><table class="turns-table"><thead><tr><th>Việc</th><th>Mức</th><th>Thiếu</th><th>Hành động</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
        actions: ['WHY'],
        has_write_buttons: false,
    };
}

/**
 * Transport mapping for the S1 surface. `OUT_OF_SCOPE` is 403 in `API-4`;
 * a projection failure is 500 — never 200, and never ST1 ("empty") for a read
 * that failed. Kept out of the Nest controller so it stays testable without
 * booting a server.
 */
export function s1HttpResult(page: any): { status: number; html: string } {
    if (!page || typeof page.state !== 'string') {
        return { status: 500, html: '' };
    }
    switch (page.state) {
        case UI_STATES.ST4_DENIED:
            return { status: 403, html: page.html };
        case UI_STATES.ST3_FAILED:
            return { status: 500, html: page.html };
        default:
            return { status: 200, html: page.html };
    }
}

/**
 * One S1 request, decided without HTTP: access → read → render → status.
 *
 * The controller owns three things only — the guard, the reply object and this
 * call. Keeping the decision here means ST4 is exercised by tests through the
 * same path the route uses, instead of only through a hand-built frame.
 */
export function renderS1Request({
    project = 'default',
    canRead = () => true,
    loadTurns = () => [],
}: any = {}) {
    // AC-UI-01-04: denial is decided before any read, so the answer cannot
    // differ between "not found" and "no permission".
    if (!canRead(project)) {
        const page = renderWorkOverviewPage({ project, hasAccess: false });
        return { ...s1HttpResult(page), page };
    }

    const failed = () => {
        // AC-UI-01-03: a failed read is ST3 + retry — never ST1 "empty".
        const page = renderWorkOverviewPage({ project, error: 'UI_FETCH_FAILED' });
        return { ...s1HttpResult(page), page };
    };

    let loaded: any;
    try {
        loaded = loadTurns(project);
    } catch {
        return failed();
    }

    /*
     * D-93: the evidence store is PostgreSQL behind an async adapter, so `loadTurns` may hand back a
     * promise. The synchronous path is kept for the existing frame tests and for any in-memory caller;
     * an async caller gets the same denial/read-failure contract, just one microtask later.
     */
    if (loaded && typeof loaded.then === 'function') {
        return Promise.resolve(loaded)
            .then((turns: any[]) => {
                const page = renderWorkOverviewPage({ project, hasAccess: true, turns: turns ?? [] });
                return { ...s1HttpResult(page), page };
            })
            .catch(() => failed());
    }

    const page = renderWorkOverviewPage({ project, hasAccess: true, turns: loaded });
    return { ...s1HttpResult(page), page };
}
