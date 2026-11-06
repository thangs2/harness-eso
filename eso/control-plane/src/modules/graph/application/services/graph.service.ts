import {
    Injectable,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { DatabaseService } from '../../../../common/infrastructure/database.service.js';
import {
    indexGraph,
    rebuildGraph,
    answerGraphQuestion,
    answerDocsGraph,
} from '../../../../../../graph/src/graph-store.mjs';
import { GraphIndexDto } from '../../api/dto/graph-index.dto.js';
import { GraphRebuildDto } from '../../api/dto/graph-rebuild.dto.js';
import { GraphQueryDto } from '../../api/dto/graph-query.dto.js';
import { GraphDocsDto } from '../../api/dto/graph-docs.dto.js';

type Envelope = { status: number; code: string; data: any };

function asException(res: Envelope): Error {
    const detail = res.data?.message || res.data?.error || res.code;
    const body = {
        status: res.status,
        code: res.code,
        error: res.code,
        detail,
        ...(res.data && typeof res.data === 'object' ? res.data : {}),
    };
    switch (res.status) {
        case 400:
            return new BadRequestException(body);
        case 403:
            return new ForbiddenException(body);
        case 409:
            return new ConflictException(body);
        case 422:
            return new UnprocessableEntityException(body);
        case 503:
            return new ServiceUnavailableException(body);
        default:
            return new BadRequestException(body);
    }
}

function unwrap(res: Envelope) {
    if (res.status >= 400) throw asException(res);
    return res.data;
}

/** A caller marks a request that runs while a turn is judging; graph work is off-path. */
export function isTurnPath(raw?: string): boolean {
    if (!raw) return false;
    return ['judging', 'on', 'true', '1'].includes(String(raw).trim().toLowerCase());
}

@Injectable()
export class GraphService {
    constructor(private readonly dbService: DatabaseService) {}

    /**
     * Graph routes are off-path. The phase is required and fail-closed: a caller that omits it
     * cannot silently run heavy work on a judging turn.
     */
    turnPhase(raw?: string): boolean {
        if (!raw || !String(raw).trim()) {
            throw new BadRequestException({
                status: 400,
                code: 'TURN_PHASE_REQUIRED',
                error: 'TURN_PHASE_REQUIRED',
                detail: 'x-eso-turn-phase must be off-path or judging',
            });
        }
        const phase = String(raw).trim().toLowerCase();
        if (phase === 'off-path' || phase === 'off_path') return false;
        if (phase === 'judging') return true;
        throw new BadRequestException({
            status: 400,
            code: 'TURN_PHASE_INVALID',
            error: 'TURN_PHASE_INVALID',
            detail: 'x-eso-turn-phase must be off-path or judging',
        });
    }

    private database() {
        const db = this.dbService.getDatabase();
        if (!db) {
            throw new ServiceUnavailableException({
                status: 503,
                code: 'DB_UNAVAILABLE',
                error: 'DB_UNAVAILABLE',
                detail: 'Graph database is not configured',
            });
        }
        return db;
    }

    async index(project: string, dto: GraphIndexDto, onTurnPath = false) {
        const db = this.database();
        const res = await indexGraph({
            db,
            project,
            buildId: dto.build_id,
            source: dto.source,
            onTurnPath,
            consumerRoot: process.env.ESO_CONSUMER_ROOT || null,
        });
        return unwrap(res as Envelope);
    }

    async rebuild(project: string, dto: GraphRebuildDto, onTurnPath = false) {
        const db = this.database();
        const res = await rebuildGraph({
            db,
            project,
            buildId: dto.build_id,
            source: dto.source,
            onTurnPath,
            consumerRoot: process.env.ESO_CONSUMER_ROOT || null,
        });
        return unwrap(res as Envelope);
    }

    async docs(project: string, dto: GraphDocsDto, onTurnPath = false) {
        const db = this.database();
        const res = await answerDocsGraph({
            db,
            project,
            buildId: dto.build_id || null,
            node: dto.node,
            onTurnPath,
        });
        return unwrap(res as Envelope);
    }

    async query(project: string, question: string, dto: GraphQueryDto, onTurnPath = false) {
        const db = this.database();
        const res = await answerGraphQuestion({
            db,
            project,
            question,
            buildId: dto.build_id || null,
            input: dto,
            onTurnPath,
        });
        return unwrap(res as Envelope);
    }
}
