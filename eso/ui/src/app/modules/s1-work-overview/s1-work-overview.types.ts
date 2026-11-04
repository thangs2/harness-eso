/**
 * @mu/eso-ui — S1 Work Overview Types & Contract (Angular 22 / D-72)
 */

export interface S1TurnRow {
    turn_id: string;
    work: string;
    level: string;
    missing_badge?: string;
    distinct_styling: string;
}

export interface S1OverviewState {
    project: string;
    hasAccess: boolean;
    isLoading: boolean;
    error: string | null;
    turns: any[];
    rows: S1TurnRow[];
    actions: string[];
}

export type S1ActionType = 'WHY' | 'RETRY' | 'CHANGE_PROJECT';
