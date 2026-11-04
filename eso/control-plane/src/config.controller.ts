import {
    Controller,
    Get,
    Post,
    Query,
    Body,
    UseGuards,
    HttpException,
    HttpStatus,
    HttpCode,
} from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import { DatabaseService } from './database.service.js';
import { readConfig, saveConfig } from '../src/config-store.mjs';
import { previewConfigChange } from '../src/config-mgr.mjs';

@Controller('config')
@UseGuards(AuthGuard)
export class ConfigController {
    constructor(private readonly dbService: DatabaseService) {}

    @Get()
    async getConfig(@Query('project') project: string, @Query('version') version?: string) {
        if (!project) {
            throw new HttpException(
                { error: 'PROJECT_REQUIRED', message: 'Query param project is required' },
                HttpStatus.BAD_REQUEST
            );
        }

        const db = this.dbService.getDatabase();
        const record = readConfig(db, project, version ? Number(version) : null);
        if (!record) {
            throw new HttpException(
                { error: 'CONFIG_NOT_FOUND', message: `No config found for project "${project}"` },
                HttpStatus.NOT_FOUND
            );
        }

        return { ok: true, ...record };
    }

    @Post('preview')
    @HttpCode(HttpStatus.OK)
    async previewConfig(@Body() body: any) {
        const { project, pendingChange } = body || {};
        if (!project || !pendingChange) {
            throw new HttpException(
                { error: 'INVALID_PREVIEW_PAYLOAD', message: 'project and pendingChange required' },
                HttpStatus.BAD_REQUEST
            );
        }

        const db = this.dbService.getDatabase();
        const current = readConfig(db, project);
        const currentConfig = current ? current.config : { version: 1 };
        const currentHash = current ? current.hash : null;

        const preview = previewConfigChange({
            project,
            currentConfig,
            pendingChange,
        });
        return {
            ok: true,
            current_hash: currentHash,
            preview_hash: preview.preview_hash,
            ...preview,
        };
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    async saveConfiguration(@Body() body: any) {
        const { project, config, current_hash, currentHash, preview_hash, previewHash, operator } = body || {};
        const pHash = preview_hash || previewHash;
        const cHash = current_hash !== undefined ? current_hash : (currentHash !== undefined ? currentHash : null);

        if (!pHash) {
            throw new HttpException(
                {
                    error: 'PREVIEW_REQUIRED',
                    code: 'PREVIEW_REQUIRED',
                    message: 'POST /config thiếu preview hash (phải preview trước khi save)',
                },
                HttpStatus.CONFLICT
            );
        }

        const db = this.dbService.getDatabase();
        try {
            const saved = saveConfig(db, {
                project,
                config,
                expectedHash: cHash,
                operator: operator || 'operator',
            });
            return { ok: true, ...saved };
        } catch (err: any) {
            if (err.code === 'STALE_VERSION') {
                throw new HttpException(
                    {
                        error: 'STALE_VERSION',
                        code: 'STALE_VERSION',
                        message: err.message,
                        current_hash: err.current_hash,
                    },
                    HttpStatus.CONFLICT
                );
            }
            throw new HttpException(
                { error: 'SAVE_FAILED', message: err.message },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}
