import {
    Injectable,
    ConflictException,
    BadRequestException,
    NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../../../common/infrastructure/database.service.js';
import { readConfig, saveConfig } from '../../infrastructure/persistence/repositories/config.repository.js';
import { previewConfigChange } from '../../domain/config-change.js';
import { PreviewConfigDto } from '../../api/dto/preview-config.dto.js';
import { SaveConfigDto } from '../../api/dto/save-config.dto.js';

@Injectable()
export class ConfigService {
    constructor(private readonly dbService: DatabaseService) {}

    async getConfig(project: string, version?: any) {
        if (!project) {
            throw new BadRequestException({
                type: 'https://eso.dev/errors/missing-project',
                title: 'Bad Request',
                status: 400,
                code: 'PROJECT_REQUIRED',
                error: 'PROJECT_REQUIRED',
                detail: 'Query parameter ?project= is required',
            });
        }

        let parsedVersion: number | null = null;
        if (version !== undefined && version !== null && version !== '') {
            const num = Number(version);
            if (!Number.isInteger(num) || num <= 0) {
                throw new BadRequestException({
                    type: 'https://eso.dev/errors/invalid-version',
                    title: 'Bad Request',
                    status: 400,
                    code: 'INVALID_VERSION',
                    error: 'INVALID_VERSION',
                    detail: `Invalid version parameter "${version}". Must be a positive integer.`,
                });
            }
            parsedVersion = num;
        }

        const db = this.dbService.getDatabase();
        const record = await readConfig(db, project, parsedVersion);
        if (!record) {
            throw new NotFoundException({
                type: 'https://eso.dev/errors/config-not-found',
                title: 'Not Found',
                status: 404,
                code: 'CONFIG_NOT_FOUND',
                error: 'CONFIG_NOT_FOUND',
                detail: `No config found for project "${project}"`,
            });
        }
        return {
            ok: true,
            ...record,
        };
    }

    async previewConfig(dto: PreviewConfigDto) {
        const db = this.dbService.getDatabase();
        const current = await readConfig(db, dto.project);
        const currentConfig = current ? current.config : { version: 1 };
        const currentHash = current ? current.hash : null;

        const preview = previewConfigChange({
            project: dto.project,
            currentConfig,
            pendingChange: dto.pendingChange,
        });

        return {
            ok: true,
            current_hash: currentHash,
            preview_hash: preview.preview_hash,
            diff: { current: currentConfig, pending: dto.pendingChange },
            ...preview,
        };
    }

    async saveConfig(dto: SaveConfigDto) {
        if (!dto.preview_hash || typeof dto.preview_hash !== 'string' || dto.preview_hash.trim() === '') {
            throw new ConflictException({
                type: 'https://eso.dev/errors/preview-required',
                title: 'Conflict',
                status: 409,
                code: 'PREVIEW_REQUIRED',
                error: 'PREVIEW_REQUIRED',
                detail: 'preview_hash is mandatory before saving configuration',
            });
        }

        const db = this.dbService.getDatabase();
        const current = await readConfig(db, dto.project);

        if (current) {
            if (!dto.current_hash || dto.current_hash !== current.hash) {
                throw new ConflictException({
                    type: 'https://eso.dev/errors/stale-version',
                    title: 'Conflict',
                    status: 409,
                    code: 'STALE_VERSION',
                    error: 'STALE_VERSION',
                    detail: `STALE_VERSION: Expected current_hash "${dto.current_hash}" does not match database hash "${current.hash}" (version ${current.version})`,
                });
            }
        } else if (dto.current_hash) {
            throw new ConflictException({
                type: 'https://eso.dev/errors/stale-version',
                title: 'Conflict',
                status: 409,
                code: 'STALE_VERSION',
                error: 'STALE_VERSION',
                detail: `STALE_VERSION: Project "${dto.project}" has no prior version, expected hash "${dto.current_hash}" is invalid`,
            });
        }

        const expectedPreview = previewConfigChange({
            project: dto.project,
            currentConfig: current ? current.config : { version: 1 },
            pendingChange: dto.config,
        }).preview_hash;

        if (dto.preview_hash !== expectedPreview) {
            throw new ConflictException({
                type: 'https://eso.dev/errors/stale-preview-hash',
                title: 'Conflict',
                status: 409,
                code: 'CONFIG_STALE_HASH',
                error: 'CONFIG_STALE_HASH',
                detail: `Preview hash mismatch. Expected "${expectedPreview}", got "${dto.preview_hash}". Configuration may have been modified.`,
            });
        }

        try {
            const saved = await saveConfig(db, {
                project: dto.project,
                config: dto.config,
                expectedHash: dto.current_hash || null,
                operator: dto.operator || 'system',
            });
            return {
                ok: true,
                project: dto.project,
                version: saved.version,
                hash: saved.hash,
                updated_at: saved.saved_at,
            };
        } catch (err: any) {
            if (err?.code === 'STALE_VERSION' || err?.message?.includes('STALE_VERSION')) {
                throw new ConflictException({
                    type: 'https://eso.dev/errors/stale-version',
                    title: 'Conflict',
                    status: 409,
                    code: 'STALE_VERSION',
                    error: 'STALE_VERSION',
                    detail: err.message,
                });
            }
            if (err?.code === 'PREVIEW_REQUIRED') {
                throw new ConflictException({
                    type: 'https://eso.dev/errors/preview-required',
                    title: 'Conflict',
                    status: 409,
                    code: 'PREVIEW_REQUIRED',
                    error: 'PREVIEW_REQUIRED',
                    detail: err.message,
                });
            }
            throw err;
        }
    }
}
