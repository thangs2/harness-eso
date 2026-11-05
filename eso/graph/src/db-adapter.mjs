/**
 * Unified PostgreSQL DB adapter using Bun.SQL (D-92/D-93 / ESO-447).
 *
 * Invariants:
 * - D-92 / D-93: Graph database is PostgreSQL ONLY. SQLite is strictly prohibited.
 * - INV-GR-03: Multi-tenant project isolation with PostgreSQL RLS.
 * - Single contract providing exec, run, all, get, begin, close without SQLite dependencies.
 */

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
        } else if (typeof val === 'string' && /^-?\d+$/.test(val) && val.length >= 16) {
            try {
                const b = BigInt(val);
                if (b > MAX_SAFE_BIGINT || b < MIN_SAFE_BIGINT) {
                    row[key] = b;
                }
            } catch {}
        }
    }
    return row;
}

export function normalizeQuery(sql, args) {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        const paramObj = args[0];
        const positionalParams = [];
        let index = 1;
        const transformedSql = sql.replace(/([:@$][a-zA-Z0-9_]+)/g, (match, paramName) => {
            const keyWithoutPrefix = paramName.slice(1);
            if (paramName in paramObj) {
                positionalParams.push(paramObj[paramName]);
                return `$${index++}`;
            } else if (keyWithoutPrefix in paramObj) {
                positionalParams.push(paramObj[keyWithoutPrefix]);
                return `$${index++}`;
            }
            return match;
        });
        return { sql: transformedSql, params: positionalParams };
    }

    const flatParams = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;

    if (sql.includes('?')) {
        let index = 1;
        const transformedSql = sql.replace(/\?/g, () => `$${index++}`);
        return { sql: transformedSql, params: flatParams };
    }

    return { sql, params: flatParams };
}

function wrapClient(raw, options = {}) {
    return {
        raw,
        isBun: false,
        isPostgres: true,

        async exec(sql) {
            return await raw.unsafe(sql);
        },

        async run(sql, ...params) {
            const { sql: normSql, params: normParams } = normalizeQuery(sql, params);
            const res = await raw.unsafe(normSql, normParams);
            return {
                changes: res.count !== null && res.count !== undefined ? Number(res.count) : (res.affectedRows || 0),
                lastInsertRowid: res.lastInsertRowid,
            };
        },

        async all(sql, ...params) {
            const { sql: normSql, params: normParams } = normalizeQuery(sql, params);
            const rows = await raw.unsafe(normSql, normParams);
            return Array.from(rows).map(normalizeRow);
        },

        async get(sql, ...params) {
            const rows = await this.all(sql, ...params);
            return rows.length > 0 ? rows[0] : undefined;
        },

        async begin(fn) {
            return await raw.begin(async (tx) => {
                const txAdapter = wrapClient(tx, options);
                return await fn(txAdapter);
            });
        },

        async close() {
            if (typeof raw.close === 'function') {
                return await raw.close();
            }
        },
    };
}

export function createDbAdapter(urlOrConfig, options = {}) {
    if (typeof Bun === 'undefined' || typeof Bun.SQL !== 'function') {
        throw new Error('Bun runtime with Bun.SQL is required for PostgreSQL graph database adapter (D-92/D-93)');
    }

    let rawUrl = null;
    if (typeof urlOrConfig === 'string') {
        const trimmed = urlOrConfig.trim();
        if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
            rawUrl = trimmed;
        } else {
            throw new Error('PostgreSQL connection URL required for graph database (D-92/D-93). SQLite is prohibited.');
        }
    } else if (urlOrConfig && typeof urlOrConfig === 'object') {
        if (typeof urlOrConfig.url === 'string') {
            rawUrl = urlOrConfig.url.trim();
        }
    }

    if (!rawUrl) {
        rawUrl = process.env.ESO_GRAPH_DB_URL || process.env.GRAPH_DATABASE_URL || process.env.DATABASE_URL;
    }

    if (!rawUrl || (!rawUrl.startsWith('postgres://') && !rawUrl.startsWith('postgresql://'))) {
        throw new Error('PostgreSQL connection URL required for graph database (D-92/D-93). SQLite is prohibited.');
    }

    const opts = (urlOrConfig && typeof urlOrConfig === 'object' && !urlOrConfig.url) ? urlOrConfig : options;
    const targetSchema = opts?.schema || opts?.searchPath;

    let connUrl = rawUrl;
    if (targetSchema) {
        const sep = connUrl.includes('?') ? '&' : '?';
        connUrl = `${connUrl}${sep}options=-csearch_path%3D${encodeURIComponent(targetSchema)}`;
    }

    const rawDb = new Bun.SQL(connUrl);
    return wrapClient(rawDb, opts);
}
