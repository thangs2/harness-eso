/**
 * API Contract Types (Generated from Control Plane OpenAPI / RFC 9457)
 * NEVER hand-write DTOs in feature code.
 */

export interface WorkOverviewTurnDto {
    turn_id: string;
    work: string;
    level: 'sufficient' | 'partial' | 'missing' | 'none';
    missing_count: number;
    distinct_styling: string;
    timestamp?: string;
}

export interface WorkOverviewResponse {
    project: string;
    total: number;
    items: WorkOverviewTurnDto[];
}

export interface ConfigPreviewDto {
    config: Record<string, unknown>;
    hash: string;
    impactSummary?: string;
}

export interface ProblemDetailsDto {
    type?: string;
    title: string;
    status: number;
    detail?: string;
    instance?: string;
}
