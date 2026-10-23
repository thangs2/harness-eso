import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoNow, openDb } from '@mu/harness-foundation';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** Apply every `db/migrations/NNN_*.sql` whose version is not yet recorded. */
export function migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
    );`);
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
    const done = [];
    for (const file of files) {
        const version = Number.parseInt(file.split('_')[0], 10);
        if (!Number.isFinite(version) || applied.has(version)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        db.tx(() => {
            db.exec(sql);
            db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
                version,
                file,
                isoNow(),
            ]);
        });
        done.push(file);
    }
    return done;
}

/** Insert or replace the single project row (= this project). */
export function upsertProject(db, cfg) {
    const now = isoNow();
    db.run(
        `INSERT INTO project (id, display_name, root_path, config_path, storage_driver, storage_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             root_path = excluded.root_path,
             config_path = excluded.config_path,
             storage_driver = excluded.storage_driver,
             storage_target = excluded.storage_target,
             updated_at = excluded.updated_at`,
        [
            cfg.project.id,
            cfg.project.displayName || cfg.project.id,
            cfg.root,
            cfg.configPath,
            cfg.storage.driver,
            cfg.storage.target,
            now,
            now,
        ],
    );
}

export function healthCheck(db) {
    try {
        const row = db.get('SELECT COUNT(*) AS n FROM project');
        return { ok: true, projects: row ? row.n : 0, driver: db.driver, path: db.filePath };
    } catch (err) {
        return { ok: false, error: err.message, driver: db.driver, path: db.filePath };
    }
}

export function dbCounts(db) {
    return db.get(
        `SELECT (SELECT COUNT(*) FROM request) AS requests,
                (SELECT COUNT(*) FROM llm_call) AS calls,
                (SELECT COUNT(*) FROM event) AS events,
                (SELECT COUNT(*) FROM conversation) AS conversations`,
    );
}

export { openDb };
