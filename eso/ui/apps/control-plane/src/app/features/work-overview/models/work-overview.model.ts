/**
 * View Models for S1 Work Overview
 * SKILL.md §1.2: models must be view models, NOT API DTOs.
 */

export interface WorkOverviewItem {
    turnId: string;
    work: string;
    level: 'sufficient' | 'partial' | 'missing' | 'none';
    missingBadge: string;
    distinctStyling: string;
}

export interface WorkOverviewSummary {
    project: string;
    total: number;
    items: WorkOverviewItem[];
}
