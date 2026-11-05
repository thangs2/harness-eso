import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../common/infrastructure/database.service.js';

export interface EvidenceTurnRow {
    project: string;
    turn_id: string;
    at: string;
    actor_role: string;
    actor_status: string;
    level: string;
    mode: string;
    basis: string;
    rule_version: string;
    payload: any;
}

@Injectable()
export class EvidenceRepository {
    constructor(private readonly dbService: DatabaseService) {}

    /**
     * D-93: the control plane talks to PostgreSQL through the async Bun.SQL adapter. A synchronous
     * `list()` would hand callers a promise instead of rows, so the read is awaited here and the
     * callers (the S1 page + the JSON surface) await this method in turn.
     */
    async list(project: string, limit = 50): Promise<EvidenceTurnRow[]> {
        const db = this.dbService.getDatabase();
        if (!db || typeof db.all !== 'function') return [];

        const rows = await db.all(
            'SELECT * FROM evidence_turn WHERE project = ? ORDER BY at DESC LIMIT ?',
            project,
            limit,
        );

        return rows.map((row: any) => ({
            project: row.project,
            turn_id: row.turn_id,
            at: row.at,
            actor_role: row.actor_role,
            actor_status: row.actor_status,
            level: row.level,
            mode: row.mode,
            basis: row.basis,
            rule_version: row.rule_version,
            payload: (() => {
                try {
                    return typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : row.payload || {};
                } catch {
                    return {};
                }
            })(),
        }));
    }
}
