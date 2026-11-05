import { createDbAdapter } from '../../eso/graph/src/db-adapter.mjs';
import { initSchema } from '../../eso/graph/src/schema.mjs';

/**
 * Isolated PostgreSQL graph test helper (D-92 / D-93 / ESO-447).
 * Connects to PostgreSQL using strictly ESO_GRAPH_DB_URL, creates a unique test schema,
 * and initializes target schema DDL.
 */
export async function createTestPgGraph() {
    const url = process.env.ESO_GRAPH_DB_URL || process.env.GRAPH_DATABASE_URL;
    if (!url) {
        throw new Error('ESO_GRAPH_DB_URL is required to run PostgreSQL graph tests (D-92/D-93)');
    }

    const schema = `test_graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const admin = new Bun.SQL(url);
    await admin.unsafe(`CREATE SCHEMA ${schema};`);
    await admin.close();

    const db = createDbAdapter(url, { schema });
    await initSchema(db);

    return {
        db,
        schema,
        async cleanup() {
            try {
                await db.close();
            } catch {}
            try {
                const cleanupAdmin = new Bun.SQL(url);
                await cleanupAdmin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
                await cleanupAdmin.close();
            } catch {}
        },
    };
}
