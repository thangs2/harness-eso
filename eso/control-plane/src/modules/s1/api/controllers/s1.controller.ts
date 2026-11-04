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
import { renderS1Page } from '../../../../../src/page/s1.mjs';
import { listTurnEvidence } from '../../../../../../adapters/src/host-bridge.mjs';

@Controller('s1')
@UseGuards(AuthGuard)
export class S1Controller {
    constructor(private readonly dbService: DatabaseService) {}

    @Get()
    getS1Page(
        @Query('project') project: string,
        @Res({ passthrough: true }) reply: FastifyReply
    ) {
        const db = this.dbService.getDatabase();
        let turns: any[] = [];
        try {
            turns = listTurnEvidence({ db, project: project || 'default' });
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
