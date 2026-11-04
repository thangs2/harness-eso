import {
    Controller,
    Get,
    Query,
    UseGuards,
    Res,
} from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import { DatabaseService } from './database.service.js';
import { renderS1Page } from '../src/page/index.mjs';
import { listTurnEvidence } from '../../adapters/src/host-bridge.mjs';

@Controller('s1')
@UseGuards(AuthGuard)
export class S1Controller {
    constructor(private readonly dbService: DatabaseService) {}

    @Get()
    async getS1Page(@Query('project') project: string = 'default', @Res({ passthrough: true }) res: any) {
        const db = this.dbService.getDatabase();
        let turns = [];
        if (db) {
            try {
                turns = listTurnEvidence({ db, project, limit: 50 });
            } catch {
                turns = [];
            }
        }

        const page = renderS1Page({
            project,
            hasAccess: true,
            turns,
        });

        if (res && typeof res.header === 'function') {
            res.header('content-type', 'text/html; charset=utf-8');
        } else if (res && typeof res.setHeader === 'function') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
        }

        return page.html;
    }
}
