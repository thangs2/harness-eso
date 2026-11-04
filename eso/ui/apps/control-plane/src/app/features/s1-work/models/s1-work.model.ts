/**
 * View Models for S1 Work Overview
 * SKILL.md §1.2: models must be view models, NOT API DTOs.
 */

export interface S1WorkItem {
    turnId: string;
    work: string;
    level: 'sufficient' | 'partial' | 'missing' | 'none';
    missingBadge: string;
    distinctStyling: string;
}

export interface S1WorkSummary {
    project: string;
    total: number;
    items: S1WorkItem[];
}
