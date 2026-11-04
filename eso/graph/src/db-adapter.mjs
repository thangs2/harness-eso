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

function normalizeOptions(options) {
    const opts = options ? { ...options } : {};
    const isReadOnly = Boolean(opts.readonly || opts.readOnly);
    if (isBun) {
        opts.safeIntegers = true;
        if (isReadOnly) {
            opts.readonly = true;
            delete opts.readOnly;
        }
    } else {
        if (isReadOnly) {
            opts.readOnly = true;
            delete opts.readonly;
        }
    }
    return opts;
}

function normalizeQuery(sql, args) {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        const paramObj = args[0];
        const positionalParams = [];
        const transformedSql = sql.replace(/([:@$][a-zA-Z0-9_]+)/g, (match, paramName) => {
            const keyWithoutPrefix = paramName.slice(1);
            if (paramName in paramObj) {
                positionalParams.push(paramObj[paramName]);
                return '?';
            } else if (keyWithoutPrefix in paramObj) {
                positionalParams.push(paramObj[keyWithoutPrefix]);
                return '?';
            }
            return match;
        });
        return { sql: transformedSql, params: positionalParams };
    }
    if (args.length === 1 && Array.isArray(args[0])) {
        return { sql, params: args[0] };
    }
    return { sql, params: args };
}

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    for (const key of Object.keys(row)) {
        const val = row[key];
        if (typeof val === 'bigint') {
            if (val >= MIN_SAFE_BIGINT && val <= MAX_SAFE_BIGINT) {
                row[key] = Number(val);
            }
        }
    }
    return row;
}

export function createDbAdapter(filename = ':memory:', options) {
    const normOptions = normalizeOptions(options);
    const rawDb = isBun
        ? new BunDatabaseClass(filename, normOptions)
        : new DatabaseSyncClass(filename, normOptions);

    return {
        raw: rawDb,
        isBun,

        exec(sql) {
            return rawDb.exec(sql);
        },

        run(sql, ...params) {
            const { sql: normSql, params: normParams } = normalizeQuery(sql, params);
            if (isBun) {
                const query = rawDb.query(normSql);
                return query.run(...normParams);
            }
            const stmt = rawDb.prepare(normSql);
            return stmt.run(...normParams);
        },

        all(sql, ...params) {
            const { sql: normSql, params: normParams } = normalizeQuery(sql, params);
            if (isBun) {
                const query = rawDb.query(normSql);
                const rows = query.all(...normParams);
                return rows.map(normalizeRow);
            }
            const stmt = rawDb.prepare(normSql);
            if (typeof stmt.setReadBigInts === 'function') {
                stmt.setReadBigInts(true);
            }
            const rows = stmt.all(...normParams);
            return rows.map(normalizeRow);
        },

        get(sql, ...params) {
            const { sql: normSql, params: normParams } = normalizeQuery(sql, params);
            if (isBun) {
                const query = rawDb.query(normSql);
                const res = query.get(...normParams);
                return res === null || res === undefined ? undefined : normalizeRow(res);
            }
            const stmt = rawDb.prepare(normSql);
            if (typeof stmt.setReadBigInts === 'function') {
                stmt.setReadBigInts(true);
            }
            const res = stmt.get(...normParams);
            return res === null || res === undefined ? undefined : normalizeRow(res);
        },

        close() {
            return rawDb.close();
        },
    };
}
