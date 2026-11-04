import {
    Controller,
    Get,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { DatabaseService } from '../../../../common/infrastructure/database.service.js';
import { renderS1Page } from '../../application/s1.presenter.js';
import { EvidenceRepository } from '../../infrastructure/evidence.repository.js';

@Controller('s1')
@UseGuards(AuthGuard)
export class S1Controller {
    constructor(
        private readonly dbService: DatabaseService,
        private readonly evidence: EvidenceRepository
    ) {}

    @Get()
    getS1Page(
        @Query('project') project: string,
        @Res({ passthrough: true }) reply: FastifyReply
    ) {
        const db = this.dbService.getDatabase();
        let turns: any[] = [];
        try {
            turns = this.evidence.list(project || 'default');
        } catch {}

        const page = renderS1Page({
            project: project || 'default',
            hasAccess: true,
            turns,
        });

        reply.header('content-type', 'text/html; charset=utf-8');
        return page.html;
    }
}
