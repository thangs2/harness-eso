export const CONSUMER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project (
    project TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sdlc_profile (
    project TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    sdlc_root TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project, version)
);

CREATE INDEX IF NOT EXISTS idx_sdlc_profile_project ON sdlc_profile(project);
`;

export async function ensureConsumerSchema(db: any): Promise<void> {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('Database with .exec() method is required to initialize consumer schema');
    }
    await db.exec(CONSUMER_SCHEMA_SQL);
}
