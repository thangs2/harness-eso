import { Module } from '@nestjs/common';
import { WorkOverviewController } from './api/controllers/work-overview.controller.js';
import { PROJECT_ACCESS } from './application/ports/project-access.port.js';
import { EvidenceRepository } from './infrastructure/evidence.repository.js';
import { AllowAllProjectAccess } from './infrastructure/project-access/allow-all.project-access.js';

@Module({
    controllers: [WorkOverviewController],
    providers: [
        EvidenceRepository,
        { provide: PROJECT_ACCESS, useClass: AllowAllProjectAccess },
    ],
})
export class WorkOverviewModule {}
