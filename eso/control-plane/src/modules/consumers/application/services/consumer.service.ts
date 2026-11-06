import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConsumerProfileDto } from '../../api/dto/consumer-profile.dto.js';
import { ConsumerRepository, ConsumerProfileInput } from '../../infrastructure/persistence/consumer.repository.js';

@Injectable()
export class ConsumerService {
    constructor(private readonly repository: ConsumerRepository) {}

    private assertProjectContext(authProject?: string | null): string {
        if (!authProject || typeof authProject !== 'string' || !authProject.trim()) {
            throw new ForbiddenException({
                type: 'https://eso.dev/errors/forbidden',
                title: 'Forbidden',
                status: 403,
                code: 'AUTH_PROJECT_MISSING',
                error: 'AUTH_PROJECT_MISSING',
                detail: 'Authentication project scope not configured on server (fail-closed)',
            });
        }
        return authProject;
    }

    private assertScopeMatch(targetProject: string, authProject: string) {
        if (targetProject !== authProject) {
            throw new ForbiddenException({
                type: 'https://eso.dev/errors/forbidden',
                title: 'Forbidden',
                status: 403,
                code: 'OUT_OF_SCOPE',
                error: 'OUT_OF_SCOPE',
                detail: `Target project "${targetProject}" does not match authenticated project "${authProject}"`,
            });
        }
    }

    async list(project: string) {
        const authProject = this.assertProjectContext(project);
        const rows = await this.repository.list(authProject);
        return {
            items: rows.map((row) => this.toSummary(row)),
        };
    }

    async get(project: string, currentProject: string) {
        const authProject = this.assertProjectContext(currentProject);
        this.assertScopeMatch(project, authProject);
        const row = await this.repository.get(project);
        if (!row) {
            throw new NotFoundException({
                code: 'CONSUMER_NOT_FOUND',
                detail: `No consumer profile for project "${project}"`,
            });
        }
        return this.toResponse(row);
    }

    async create(dto: ConsumerProfileDto, project: string) {
        const authProject = this.assertProjectContext(project);
        this.validate(dto);
        this.assertScopeMatch(dto.id, authProject);
        if (await this.repository.get(dto.id)) {
            throw new ConflictException({
                code: 'CONSUMER_EXISTS',
                detail: `Consumer "${dto.id}" already has a profile`,
            });
        }
        return this.toResponse(await this.repository.create(dto as ConsumerProfileInput));
    }

    async update(project: string, dto: ConsumerProfileDto, currentProject: string) {
        const authProject = this.assertProjectContext(currentProject);
        this.assertScopeMatch(project, authProject);
        if (dto.id !== project) {
            throw new BadRequestException({
                code: 'CONSUMER_ID_MISMATCH',
                detail: `Body id "${dto.id}" does not match path "${project}"`,
            });
        }
        this.validate(dto);
        if (!(await this.repository.get(project))) {
            throw new NotFoundException({
                code: 'CONSUMER_NOT_FOUND',
                detail: `No consumer profile for project "${project}"`,
            });
        }
        return this.toResponse(await this.repository.update(project, dto as ConsumerProfileInput));
    }


    plan(dto: ConsumerProfileDto, project: string) {
        const authProject = this.assertProjectContext(project);
        this.validate(dto);
        this.assertScopeMatch(dto.id, authProject);
        const warnings: string[] = [];
        if (!dto.root.startsWith('/') && !/^[A-Za-z]:\\/.test(dto.root)) {
            warnings.push('root nên là đường dẫn tuyệt đối tới repo consumer.');
        }
        if (dto.profile.recipe === 'lite' && (dto.sources.docgraph || dto.sources.codegraph || dto.sources.memory)) {
            warnings.push('Recipe Lite không dùng external provider; các source đang bật sẽ không có tác dụng.');
        }
        if (dto.integration.jevMode !== 'off' && !dto.integration.consent) {
            warnings.push('JEV đang bật nhưng chưa cấp consent ghi evidence.');
        }
        const files: Array<{ relative: string; action: string; preview: unknown }> = [
            {
                relative: 'harness.config.json',
                action: 'create-if-missing',
                preview: {
                    project: { id: dto.id, name: dto.name },
                    server: { port: dto.observePort || 8792 },
                    hostMode: dto.hostMode || 'dual-ide',
                    profile: dto.profile,
                },
            },
            {
                relative: '.harness/decision-policy.json',
                action: 'merge',
                preview: {
                    eso: { enabled: true, sources: dto.sources },
                    paths: { locked: dto.protectedPaths },
                    team: dto.team,
                    gates: dto.gates,
                    integration: dto.integration,
                },
            },
            {
                relative: '.harness/sidecar.env',
                action: 'create-if-missing',
                preview: { HARNESS_SIDECAR_URL: `http://127.0.0.1:${dto.observePort || 8792}` },
            },
        ];
        if ((dto.hostMode || 'dual-ide') === 'dual-ide' || dto.profile.hostProfile.startsWith('cursor')) {
            files.push({
                relative: '.cursor/hooks.json',
                action: 'merge',
                preview: { hooks: { beforeShellExecution: '.harness/host-pack/route-hook.py' } },
            });
        }
        if ((dto.hostMode || 'dual-ide') === 'dual-ide' || dto.profile.hostProfile.startsWith('agents')) {
            files.push({
                relative: '.agents/hooks.json',
                action: 'merge',
                preview: { hooks: { beforeShellExecution: '.harness/host-pack/route-hook.py' } },
            });
        }
        files.push({
            relative: '.harness/host-pack/',
            action: 'runtime',
            preview: { note: 'Host pack được build bởi scripts/build-host-pack.mjs trước khi provision.' },
        });
        return {
            root: dto.root,
            consumer: dto.id,
            profile: dto.profile,
            files,
            warnings,
            generatedAt: new Date().toISOString(),
        };
    }

    private validate(dto: ConsumerProfileDto): void {
        if (!dto.id || typeof dto.id !== 'string' || !dto.id.trim()) this.bad('CONSUMER_ID_REQUIRED', 'id is required');
        if (!dto.name?.trim()) this.bad('CONSUMER_NAME_REQUIRED', 'name is required');
        if (!dto.root?.trim()) this.bad('CONSUMER_ROOT_REQUIRED', 'root is required');
        if (!dto.sdlcRoot?.trim()) this.bad('SDLC_ROOT_REQUIRED', 'sdlcRoot is required');
        if (!dto.headerProfile?.trim()) this.bad('HEADER_PROFILE_REQUIRED', 'headerProfile is required');
        if (!dto.integration || typeof dto.integration !== 'object') {
            this.bad('INTEGRATION_REQUIRED', 'integration object is required');
        }
        if (!dto.profile?.recipe || !dto.profile?.hostProfile) {
            this.bad('PROFILE_REQUIRED', 'profile.recipe and profile.hostProfile are required');
        }
        if (!Array.isArray(dto.zones) || dto.zones.length === 0) {
            this.bad('ZONES_REQUIRED', 'at least one zone is required');
        }
        const zoneNames = new Set(dto.zones.map((zone) => zone.name));
        if (!zoneNames.has('human') || !zoneNames.has('agent')) {
            this.bad('ZONE_HUMAN_AGENT_REQUIRED', 'zones must include human and agent');
        }
        for (const zone of dto.zones) {
            if (!zone.path?.trim()) this.bad('ZONE_PATH_REQUIRED', `zone ${zone.name} has no path`);
        }
        if (!Array.isArray(dto.team?.roles) || dto.team.roles.length === 0) {
            this.bad('TEAM_ROLES_REQUIRED', 'team.roles must contain at least one role');
        }
        if (!Array.isArray(dto.protectedPaths)) {
            this.bad('PROTECTED_PATHS_REQUIRED', 'protectedPaths must be an array');
        }
        if (!dto.gates || typeof dto.gates !== 'object') this.bad('GATES_REQUIRED', 'gates object is required');
        if (!dto.sources || typeof dto.sources !== 'object') this.bad('SOURCES_REQUIRED', 'sources object is required');
        if (!dto.tools || typeof dto.tools !== 'object') this.bad('TOOLS_REQUIRED', 'tools object is required');
    }

    private bad(code: string, detail: string): never {
        throw new BadRequestException({ code, detail });
    }

    private summaryProfile(row: any) {
        const parsed = JSON.parse(row.profile_json);
        return parsed.profile || { recipe: 'pro', hostProfile: 'cursor-superset' };
    }

    private summaryIntegration(row: any) {
        const parsed = JSON.parse(row.profile_json);
        return parsed.integration || { jevMode: 'off', consent: true, hostPack: 'full', memoryAdapter: 'none' };
    }

    private toSummary(row: any) {
        return {
            id: row.project,
            name: row.name,
            root: row.root,
            sdlcRoot: row.sdlc_root,
            profile: this.summaryProfile(row),
            integration: this.summaryIntegration(row),
            version: row.version,
            status: row.status,
            updatedAt: row.updated_at,
        };
    }

    private toResponse(row: any) {
        const parsed = JSON.parse(row.profile_json);
        return {
            ...parsed,
            profile: this.summaryProfile(row),
            integration: parsed.integration || { jevMode: 'off', consent: true, hostPack: 'full', memoryAdapter: 'none' },
            version: row.version,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
