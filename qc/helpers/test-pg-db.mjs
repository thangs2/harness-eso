import { createDbAdapter } from '../../eso/graph/src/db-adapter.mjs';

/**
 * Isolated PostgreSQL test database/schema for non-graph ESO stores (D-93).
 * No SQLite fallback: the caller must provide a PostgreSQL URL.
 */
export async function createTestPgDb(envNames = ['ESO_TEST_DB_URL', 'ESO_GRAPH_DB_URL', 'ESO_CTX_DB_URL']) {
    const url = envNames.map((name) => process.env[name]).find(Boolean);
    if (!url) {
        throw new Error('TEST_DB_URL_REQUIRED: set ESO_TEST_DB_URL/ESO_GRAPH_DB_URL/ESO_CTX_DB_URL (PostgreSQL only)');
    }
    const schema = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new Bun.SQL(url);
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await admin.close();

    const db = createDbAdapter(url, { schema });
    return {
        db,
        schema,
        url,
        async reconnect() {
            return createDbAdapter(url, { schema });
        },
        url,
        /** A fresh handle on the same schema: what a process restart looks like without a file. */
        async reconnect() {
            return createDbAdapter(url, { schema });
        },
        async cleanup() {
            try { await db.close(); } catch {}
            try {
                const cleanupAdmin = new Bun.SQL(url);
                await cleanupAdmin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
                await cleanupAdmin.close();
            } catch {}
        },
    };
}
