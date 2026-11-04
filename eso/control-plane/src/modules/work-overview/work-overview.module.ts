import { Module } from '@nestjs/common';
import { WorkOverviewController } from './api/controllers/work-overview.controller.js';
import { EvidenceRepository } from './infrastructure/evidence.repository.js';

@Module({
    controllers: [WorkOverviewController],
    providers: [EvidenceRepository],
})
export class WorkOverviewModule {}
