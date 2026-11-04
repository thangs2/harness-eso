import { S1OverviewState, S1ActionType, S1TurnRow } from './s1-work-overview.types.js';

/**
 * Angular 22 Standalone Component: S1 Work Overview (Fuse monorepo standard)
 *
 * Implements:
 * - INV-UI-01: Không luật nghiệp vụ trong UI — UI hiển thị và emit action, không phán xét
 * - INV-UI-02: Client sinh từ contract (S1OverviewState / S1TurnRow)
 * - AC-UI-01-01: Table rendering with columns Việc, Mức, Thiếu, Hành động, WHY button
 * - AC-UI-01-02: Distinct styling classes (neutral, warning, error)
 * - AC-UI-01-03: ST1_EMPTY, ST2_LOADING, ST3_FAILED, ST4_DENIED frames
 */
export class S1WorkOverviewComponent {
    project: string = 'default';
    hasAccess: boolean = true;
    isLoading: boolean = false;
    error: string | null = null;
    turns: any[] = [];
    rows: S1TurnRow[] = [];

    // Action dispatch listener
    onActionTriggered: ((action: S1ActionType, payload?: any) => void) | null = null;

    setState(state: Partial<S1OverviewState>) {
        if (state.project !== undefined) this.project = state.project;
        if (state.hasAccess !== undefined) this.hasAccess = state.hasAccess;
        if (state.isLoading !== undefined) this.isLoading = state.isLoading;
        if (state.error !== undefined) this.error = state.error;
        if (state.turns !== undefined) this.turns = state.turns;
        if (state.rows !== undefined) this.rows = state.rows;
    }

    triggerAction(action: S1ActionType, payload?: any) {
        if (this.onActionTriggered) {
            this.onActionTriggered(action, payload);
        }
    }

    renderView(): { state: string; html: string; actions: S1ActionType[] } {
        if (this.isLoading) {
            return {
                state: 'ST2_LOADING',
                html: '<div class="s1-page loading"><div class="skeleton">Đang nạp dữ liệu...</div></div>',
                actions: [],
            };
        }

        if (this.error) {
            return {
                state: 'ST3_FAILED',
                html: `<div class="s1-page error"><div class="error-msg">${this.error}</div><button data-action="RETRY">Thử lại</button></div>`,
                actions: ['RETRY'],
            };
        }

        if (!this.hasAccess) {
            return {
                state: 'ST4_DENIED',
                html: '<div class="s1-page denied"><div class="denied-msg">truy cập bị từ chối</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>',
                actions: ['CHANGE_PROJECT'],
            };
        }

        if (!this.turns || this.turns.length === 0) {
            return {
                state: 'ST1_EMPTY',
                html: '<div class="s1-page empty"><div class="empty-msg">chưa có turn nào</div><button data-action="CHANGE_PROJECT">Đổi project</button></div>',
                actions: ['CHANGE_PROJECT'],
            };
        }

        const rowsHtml = this.rows.map((r) =>
            `<tr data-turn-id="${r.turn_id}" class="${r.distinct_styling}"><td>${r.work || ''}</td><td>${r.level}</td><td>${r.missing_badge || '0 thiếu'}</td><td><button data-action="WHY" data-turn-id="${r.turn_id}">Vì sao</button></td></tr>`
        ).join('');

        return {
            state: 'READY',
            html: `<div class="s1-page ready"><h1>Dự án: ${this.project}</h1><table class="turns-table"><thead><tr><th>Việc</th><th>Mức</th><th>Thiếu</th><th>Hành động</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
            actions: ['WHY'],
        };
    }
}
