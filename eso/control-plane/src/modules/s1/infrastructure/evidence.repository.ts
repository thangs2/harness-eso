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

    list(project: string, limit = 50): EvidenceTurnRow[] {
        const db = this.dbService.getDatabase();
        if (!db) return [];

        const sql = 'SELECT * FROM evidence_turn WHERE project = ? ORDER BY at DESC LIMIT ?';
        let rows: any[] = [];
        if (typeof db.all === 'function') {
            rows = db.all(sql, project, limit);
        } else if (typeof db.prepare === 'function') {
            rows = db.prepare(sql).all(project, limit);
        }

        return rows.map((row) => ({
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
                    return JSON.parse(row.payload || '{}');
                } catch {
                    return {};
                }
            })(),
        }));
    }
}
