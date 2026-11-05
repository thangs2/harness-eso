import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../../common/infrastructure/database.service.js';
import { ensureConsumerSchema } from './consumer.schema.js';

export interface ConsumerProfileInput {
    id: string;
    name: string;
    root: string;
    repoUrl?: string;
    hostMode?: string;
    observePort?: number;
    sdlcRoot: string;
    profile: { recipe: string; hostProfile: string; description?: string };
    integration: Record<string, any>;
    zones: Array<{ name: string; path: string; headerProfile?: string }>;
    headerProfile: string;
    presetVersion?: string;
    tools: Record<string, any>;
    team: { roles: string[]; presets?: string[] };
    gates: Record<string, any>;
    sources: Record<string, any>;
    protectedPaths: string[];
}

export interface ConsumerProfileRow {
    project: string;
    version: number;
    name: string;
    root: string;
    sdlc_root: string;
    profile_json: string;
    status: string;
    created_at: string;
    updated_at: string;
}

@Injectable()
export class ConsumerRepository {
    constructor(private readonly dbService: DatabaseService) {}

    private db(): any {
        const db = this.dbService.getDatabase();
        if (!db) throw new Error('DATABASE_UNAVAILABLE');
        ensureConsumerSchema(db);
        return db;
    }

    list(): ConsumerProfileRow[] {
        return this.db().all(
            `SELECT p.* FROM sdlc_profile p
             JOIN (SELECT project, MAX(version) AS v FROM sdlc_profile GROUP BY project) m
               ON p.project = m.project AND p.version = m.v
             ORDER BY p.updated_at DESC`
        );
    }

    get(project: string): ConsumerProfileRow | null {
        return (
            this.db().get(
                `SELECT * FROM sdlc_profile WHERE project = ? ORDER BY version DESC LIMIT 1`,
                [project]
            ) || null
        );
    }

    create(profile: ConsumerProfileInput): ConsumerProfileRow {
        const db = this.db();
        const now = new Date().toISOString();
        db.run('INSERT OR IGNORE INTO project (project) VALUES (?)', [profile.id]);
        db.run(
            `INSERT INTO sdlc_profile
             (project, version, name, root, sdlc_root, profile_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
            [profile.id, 1, profile.name, profile.root, profile.sdlcRoot, JSON.stringify(profile), now, now]
        );
        return this.get(profile.id)!;
    }

    update(project: string, profile: ConsumerProfileInput): ConsumerProfileRow {
        const db = this.db();
        const current = this.get(project);
        if (!current) throw new Error('CONSUMER_NOT_FOUND');
        const version = current.version + 1;
        const now = new Date().toISOString();
        db.run('UPDATE sdlc_profile SET status = ? WHERE project = ? AND version = ?', [
            'superseded',
            project,
            current.version,
        ]);
        db.run(
            `INSERT INTO sdlc_profile
             (project, version, name, root, sdlc_root, profile_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
            [project, version, profile.name, profile.root, profile.sdlcRoot, JSON.stringify(profile), now, now]
        );
        return this.get(project)!;
    }
}
