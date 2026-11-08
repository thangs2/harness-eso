import { SCHEMA_SQL, POSTGRES_RLS_SQL } from '../../../eso/graph/src/schema.mjs';

export const SCHEMA_VERSION = '1.0.0';

/**
 * Plans the graph storage configuration for a consumer without mutating the input config.
 *
 * @param {object} params
 * @param {string} params.consumerId
 * @param {object} params.config
 * @param {string} params.adminUrl
 * @returns {{ storage: { graph: object }, config: object }}
 */
export function planGraphStorage({ consumerId, config, adminUrl }) {
    if (!adminUrl) {
        throw new Error('adminUrl is required to plan graph storage');
    }
    const parsed = new URL(adminUrl);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 5432;
    const database = parsed.pathname.replace(/^\//, '');
    const ssl = parsed.searchParams.get('sslmode') !== 'disable';
    const schema = 'eso';
    const isolation = 'shared';

    const graph = {
        host,
        port,
        database,
        schema,
        ssl,
        isolation,
    };

    const nextConfig = structuredClone(config || {});
    nextConfig.storage = {
        ...(nextConfig.storage || {}),
        graph,
    };

    return {
        storage: { graph },
        config: nextConfig,
    };
}

function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Applies graph storage schema and registers the consumer project.
 * Uses exactly one connection for the entire operation.
 *
 * @param {object} params
 * @param {string} params.consumerId
 * @param {() => Promise<object>} params.connect
 * @param {string} [params.schema='eso']
 * @returns {Promise<{ schemaVersion: string, project: string, applied: boolean }>}
 */
export async function applyGraphStorage({ consumerId, connect, schema = 'eso' }) {
    if (typeof connect !== 'function') {
        throw new Error('connect function is required');
    }
    const client = await connect();
    try {
        const quotedSchema = quoteIdent(schema || 'eso');
        const ddl = `
CREATE SCHEMA IF NOT EXISTS ${quotedSchema};
SET search_path TO ${quotedSchema}, public;
CREATE TABLE IF NOT EXISTS project (
  project text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);
${SCHEMA_SQL}
${POSTGRES_RLS_SQL}
`;
        await client.exec(ddl);

        const upsertSql = 'INSERT INTO project (project) VALUES ($1) ON CONFLICT (project) DO NOTHING;';
        if (typeof client.query === 'function') {
            await client.query(upsertSql, [consumerId]);
        } else if (typeof client.unsafe === 'function') {
            await client.unsafe(upsertSql, [consumerId]);
        } else {
            await client.exec(
                `INSERT INTO project (project) VALUES ('${consumerId.replace(/'/g, "''")}') ON CONFLICT (project) DO NOTHING;`,
            );
        }

        return {
            schemaVersion: SCHEMA_VERSION,
            project: consumerId,
            applied: true,
        };
    } finally {
        if (typeof client.close === 'function') {
            await client.close();
        } else if (typeof client.end === 'function') {
            await client.end();
        } else if (typeof client.release === 'function') {
            client.release();
        }
    }
}
