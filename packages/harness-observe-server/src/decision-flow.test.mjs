import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '@mu/harness-foundation';
import { migrate, upsertProject } from './observe-db.mjs';
import { loadDecisionFlowForRequest } from './decision-flow.mjs';

test('loadDecisionFlowForRequest reports accurate ingestNote based on hasRealGenerationLink', () => {
    const db = openDb(':memory:');
    try {
        migrate(db);
        const projectId = 'p1';
        const convId = 'c1';
        upsertProject(db, {
            project: { id: projectId },
            root: '/tmp/test',
            configPath: '/tmp/test/harness.config.json',
            storage: { driver: 'sqlite', target: ':memory:' },
        });
        db.run(
            `INSERT INTO conversation (id, project_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`,
            [convId, projectId],
        );

        // Turn 1: has real generation link, but no decision_ledger row
        const req1 = 'c1:1';
        db.run(
            `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, generation_id, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 1, 'test query 1', 'real-gen-123', '2026-10-14T03:00:00Z', datetime('now'), datetime('now'))`,
            [req1, projectId, convId],
        );

        const flow1 = loadDecisionFlowForRequest(db, projectId, req1, {
            tools: [{ tool: 'Grep', count: 1 }],
        });
        assert.ok(flow1);
        assert.equal(
            flow1.ingestNote,
            'No decision_ledger row — green path from transcript tools + ingest spine.',
            'when hook is linked, note must not say hooks not linked',
        );

        // Turn 2: unlinked (placeholder generation_id === reqId)
        const req2 = 'c1:2';
        db.run(
            `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, generation_id, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 2, 'test query 2', ?, '2026-10-14T03:01:00Z', datetime('now'), datetime('now'))`,
            [req2, projectId, convId, req2],
        );

        const flow2 = loadDecisionFlowForRequest(db, projectId, req2, {
            tools: [{ tool: 'Grep', count: 1 }],
        });
        assert.ok(flow2);
        assert.equal(
            flow2.ingestNote,
            'No decision_ledger row — green path from transcript tools + ingest spine (hooks not linked).',
            'when hook is not linked, note correctly identifies hooks not linked',
        );
    } finally {
        db.close();
    }
});
