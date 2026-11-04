import { Injectable, inject } from '@angular/core';
import { CONTROL_PLANE_API_CLIENT } from '../../../core/tokens.js';
import type { WorkOverviewItem } from '../models/work-overview.model.js';
import type { S1TurnDto } from '../../../../../../../libs/api-client/types.js';

/**
 * Data Service for S1 Work Overview (SKILL.md §1.2 & §4)
 * Fetches from generated API client, maps DTOs to UI ViewModels.
 * NEVER contains template or UI logic.
 */
@Injectable({
    providedIn: 'root',
})
export class WorkOverviewService {
    private readonly apiClient = inject(CONTROL_PLANE_API_CLIENT, { optional: true });

    async loadWork(project: string): Promise<WorkOverviewItem[]> {
        if (!this.apiClient) {
            return [];
        }

        const res = await this.apiClient.getWorkOverview(project);
        return (res.items || []).map((dto: S1TurnDto) => this.mapDtoToViewModel(dto));
    }

    private mapDtoToViewModel(dto: S1TurnDto): WorkOverviewItem {
        return {
            turnId: dto.turn_id,
            work: dto.work || 'Không có mô tả',
            level: dto.level,
            missingBadge: `${dto.missing_count || 0} thiếu`,
            distinctStyling: dto.distinct_styling || 'style-neutral',
        };
    }
}
