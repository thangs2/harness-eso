import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { EvidenceRepository } from '../../infrastructure/evidence.repository.js';

@Controller('api/v1/work-overview')
@UseGuards(AuthGuard)
export class WorkOverviewApiController {
    constructor(private readonly evidence: EvidenceRepository) {}

    @Get()
    async list(@Query('project') project: string) {
        const selected = project || 'default';
        // D-93: PostgreSQL read is async; await before shaping the response.
        const rows = await this.evidence.list(selected);
        const items = rows.map((row) => {
            const payload: any = row.payload || {};
            const level =
                row.level === 'sufficient'
                    ? 'sufficient'
                    : row.level === 'partial' || row.level === 'insufficient'
                      ? 'partial'
                      : 'none';
            const missingCount = Number.isInteger(payload.missing_count)
                ? payload.missing_count
                : Array.isArray(payload.gaps)
                  ? payload.gaps.length
                  : Number.isInteger(payload.gaps)
                    ? payload.gaps
                    : 0;
            return {
                turn_id: row.turn_id,
                work: payload.work || payload.task || row.turn_id,
                level,
                missing_count: missingCount,
                distinct_styling:
                    level === 'partial'
                        ? 'style-warning'
                        : level === 'sufficient'
                          ? 'style-neutral'
                          : 'style-error',
                timestamp: row.at,
            };
        });
        return { project: selected, total: items.length, items };
    }
}
