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

    private async db(): Promise<any> {
        const db = this.dbService.getDatabase();
        if (!db) throw new Error('DATABASE_UNAVAILABLE');
        await ensureConsumerSchema(db);
        return db;
    }

    async list(project: string): Promise<ConsumerProfileRow[]> {
        if (!project || typeof project !== 'string' || !project.trim()) {
            throw new Error('PROJECT_MANDATORY: ConsumerRepository.list requires project parameter');
        }
        return (await this.db()).all(
            `SELECT p.* FROM sdlc_profile p
             JOIN (SELECT project, MAX(version) AS v FROM sdlc_profile WHERE project = ? GROUP BY project) m
               ON p.project = m.project AND p.version = m.v
             WHERE p.project = ?
             ORDER BY p.updated_at DESC`,
            [project, project]
        );
    }

    async get(project: string): Promise<ConsumerProfileRow | null> {
        return (
            await (await this.db()).get(
                `SELECT * FROM sdlc_profile WHERE project = ? ORDER BY version DESC LIMIT 1`,
                [project]
            ) || null
        );
    }

    async create(profile: ConsumerProfileInput): Promise<ConsumerProfileRow> {
        const db = await this.db();
        const now = new Date().toISOString();
        await db.run('INSERT INTO project (project) VALUES (?) ON CONFLICT (project) DO NOTHING', [profile.id]);
        await db.run(
            `INSERT INTO sdlc_profile
             (project, version, name, root, sdlc_root, profile_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
            [profile.id, 1, profile.name, profile.root, profile.sdlcRoot, JSON.stringify(profile), now, now]
        );
        return (await this.get(profile.id))!;
    }

    async update(project: string, profile: ConsumerProfileInput): Promise<ConsumerProfileRow> {
        const db = await this.db();
        const current = await this.get(project);
        if (!current) throw new Error('CONSUMER_NOT_FOUND');
        const version = current.version + 1;
        const now = new Date().toISOString();
        await db.run('UPDATE sdlc_profile SET status = ? WHERE project = ? AND version = ?', [
            'superseded',
            project,
            current.version,
        ]);
        await db.run(
            `INSERT INTO sdlc_profile
             (project, version, name, root, sdlc_root, profile_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
            [project, version, profile.name, profile.root, profile.sdlcRoot, JSON.stringify(profile), now, now]
        );
        return (await this.get(project))!;
    }
}
