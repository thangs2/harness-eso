import { Injectable, inject } from '@angular/core';
import { CONTROL_PLANE_API_CLIENT } from '../../../core/tokens.js';
import type { WorkOverviewItem } from '../models/work-overview.model.js';
import type { WorkOverviewTurnDto } from '../../../../../../../libs/api-client/types.js';

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
        return (res.items || []).map((dto: WorkOverviewTurnDto) => this.mapDtoToViewModel(dto));
    }

    private mapDtoToViewModel(dto: WorkOverviewTurnDto): WorkOverviewItem {
        return {
            turnId: dto.turn_id,
            // The contract requires `work`; when a producer omits it the cell
            // says so instead of showing a fabricated work name.
            work: dto.work || 'chưa ghi',
            level: dto.level,
            missingBadge: `${dto.missing_count || 0} thiếu`,
            distinctStyling: dto.distinct_styling || 'style-neutral',
        };
    }
}
