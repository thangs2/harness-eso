import {
    Controller,
    Get,
    Inject,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { renderS1Request } from '../../application/work-overview.presenter.js';
import { PROJECT_ACCESS, ProjectAccessPort } from '../../application/ports/project-access.port.js';
import { EvidenceRepository } from '../../infrastructure/evidence.repository.js';

@Controller('work-overview')
@UseGuards(AuthGuard)
export class WorkOverviewController {
    constructor(
        private readonly evidence: EvidenceRepository,
        @Inject(PROJECT_ACCESS) private readonly projectAccess: ProjectAccessPort
    ) {}

    @Get()
    async getS1Page(
        @Query('project') project: string,
        @Res({ passthrough: true }) reply: FastifyReply
    ) {
        // The server owns the access decision (AC-UI-01-04): the S1 surface
        // only renders it. Denial answers with the one refusal sentence the
        // not-found case also gets, before the store is touched.
        // D-93: the evidence read is async, so `renderS1Request` may return a promise.
        const result = await renderS1Request({
            project: project || 'default',
            canRead: (requested: string) => this.projectAccess.canReadProject(requested),
            loadTurns: (requested: string) => this.evidence.list(requested),
        });

        reply.code(result.status).header('content-type', 'text/html; charset=utf-8');
        return result.html;
    }
}
