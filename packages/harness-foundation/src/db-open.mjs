/**
 * SQLite port — bun:sqlite or node:sqlite (W1 foundation).
 * Migrations live in @mu/harness-observe-server (W4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';
import { harnessDbFile } from './paths.mjs';

export const IS_BUN = typeof Bun !== 'undefined';

let Driver;
let driverName;

if (IS_BUN) {
    const mod = await import('bun:sqlite');
    Driver = mod.Database;
    driverName = 'bun:sqlite';
} else {
    const mod = await import('node:sqlite');
    Driver = mod.DatabaseSync;
    driverName = 'node:sqlite';
}

/** @param {unknown} p */
function params(p) {
    if (p == null) return [];
    return Array.isArray(p) ? p : Object.values(p);
}

/**
 * Pragmas applied to every connection.
 *
 * `journal_mode = WAL` lets readers run while a writer holds the lock, which is what keeps the
 * observe plane readable during ingest. The rest were missing and each one cost something real:
 *
 *   `synchronous = NORMAL` — the WAL default is FULL, so every commit fsyncs. NORMAL fsyncs only
 *     at checkpoints, which is the documented safe pairing with WAL and materially faster for the
 *     many small writes ingest performs.
 *   `wal_autocheckpoint` — bound the WAL file so it cannot grow unbounded between manual checkpoints.
 *   `cache_size = -16000` — 16 MB page cache; the default 2 MB re-reads the same b-trees every pass.
 *   `temp_store = MEMORY` — the aggregate/`GROUP BY` work in checks and stats otherwise hits disk.
 *   `mmap_size` — avoids a syscall per page read on a multi-hundred-MB DB.
 *
 * These are applied per connection on purpose: they are connection state, and a pooled connection
 * that skips them is exactly how a "we set the pragma" fix silently stops applying.
 */
const CONNECTION_PRAGMAS = [
    'PRAGMA journal_mode = WAL;',
    'PRAGMA foreign_keys = ON;',
    'PRAGMA busy_timeout = 5000;',
    'PRAGMA synchronous = NORMAL;',
    'PRAGMA temp_store = MEMORY;',
    'PRAGMA cache_size = -16000;',
    'PRAGMA mmap_size = 268435456;',
    'PRAGMA wal_autocheckpoint = 1000;',
];

export class SqliteDb {
    /** @param {string} filePath */
    constructor(filePath) {
        const dir = path.dirname(filePath);
        if (dir && dir !== '.' && filePath !== ':memory:') {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.filePath = filePath;
        this.driver = driverName;
        this.raw = new Driver(filePath);
        for (const pragma of CONNECTION_PRAGMAS) {
            try {
                this.raw.exec(pragma);
            } catch {
                // A pragma the driver does not know must not stop the connection from opening:
                // the guard is a performance knob, and losing it is strictly better than losing
                // the database.
            }
        }
    }

    exec(sql) {
        this.raw.exec(sql);
    }

    run(sql, bind) {
        if (IS_BUN) return this.raw.query(sql).run(...params(bind));
        return this.raw.prepare(sql).run(...params(bind));
    }

    all(sql, bind) {
        if (IS_BUN) return this.raw.query(sql).all(...params(bind));
        return this.raw.prepare(sql).all(...params(bind));
    }

    get(sql, bind) {
        if (IS_BUN) return this.raw.query(sql).get(...params(bind));
        return this.raw.prepare(sql).get(...params(bind));
    }

    tx(fn) {
        this.exec('BEGIN IMMEDIATE;');
        try {
            const out = fn();
            this.exec('COMMIT;');
            return out;
        } catch (err) {
            try {
                this.exec('ROLLBACK;');
            } catch {
                /* noop */
            }
            throw err;
        }
    }

    close() {
        this.raw.close();
    }
}

/** @param {string} filePath */
export function openDb(filePath) {
    return new SqliteDb(filePath);
}

/**
 * Default hot DB under `.harness/harness.db` for repoRoot.
 * @param {string} [repoRoot]
 */
export function openHarnessDb(repoRoot = findRepoRoot()) {
    if (!repoRoot) {
        throw new Error('openHarnessDb: repo root not found (missing harness.config.json)');
    }
    return openDb(harnessDbFile(repoRoot));
}
