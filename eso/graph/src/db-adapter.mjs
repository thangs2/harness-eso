/**
 * Unified SQLite DB adapter compatible with both Node.js (node:sqlite) and Bun (bun:sqlite).
 *
 * Implements T-04.5 (ESO-372): Single contract for Node + Bun without `typeof db.all` branching.
 */
const isBun = typeof process !== 'undefined' && Boolean(process.versions?.bun);

let DatabaseSyncClass;
let BunDatabaseClass;

if (isBun) {
    const { Database } = await import('bun:sqlite');
    BunDatabaseClass = Database;
} else {
    const { DatabaseSync } = await import('node:sqlite');
    DatabaseSyncClass = DatabaseSync;
}

function normalizeParams(args) {
    if (args.length === 1 && Array.isArray(args[0])) {
        return args[0];
    }
    return args;
}

export function createDbAdapter(filename = ':memory:', options) {
    const hasOptions = options && Object.keys(options).length > 0;
    const rawDb = isBun
        ? (hasOptions ? new BunDatabaseClass(filename, options) : new BunDatabaseClass(filename))
        : (hasOptions ? new DatabaseSyncClass(filename, options) : new DatabaseSyncClass(filename));

    return {
        raw: rawDb,
        isBun,

        exec(sql) {
            return rawDb.exec(sql);
        },

        run(sql, ...params) {
            const normalized = normalizeParams(params);
            if (isBun) {
                const query = rawDb.query(sql);
                return query.run(...normalized);
            }
            const stmt = rawDb.prepare(sql);
            return stmt.run(...normalized);
        },

        all(sql, ...params) {
            const normalized = normalizeParams(params);
            if (isBun) {
                const query = rawDb.query(sql);
                return query.all(...normalized);
            }
            const stmt = rawDb.prepare(sql);
            return stmt.all(...normalized);
        },

        get(sql, ...params) {
            const normalized = normalizeParams(params);
            if (isBun) {
                const query = rawDb.query(sql);
                const res = query.get(...normalized);
                return res === null ? undefined : res;
            }
            const stmt = rawDb.prepare(sql);
            const res = stmt.get(...normalized);
            return res === null ? undefined : res;
        },

        close() {
            return rawDb.close();
        },
    };
}
