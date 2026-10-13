import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '@mu/harness-foundation';
import { migrate } from './observe-db.mjs';
import { refreshRequestListCache } from './request-list-cache.mjs';

describe('refreshRequestListCache', () => {
    it('updates list columns for a request', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-list-cache-'));
        const dbPath = path.join(dir, 't.db');
        const db = openDb(dbPath);
        migrate(db);
        db.run(
            `INSERT INTO project (id, display_name, root_path, config_path, storage_driver, storage_target, created_at, updated_at)
             VALUES ('p', 'p', '/r', '/r/harness.config.json', 'sqlite', ?, datetime('now'), datetime('now'))`,
            [dbPath],
        );
        db.run(
            `INSERT INTO conversation (id, project_id, created_at, updated_at) VALUES ('c', 'p', datetime('now'), datetime('now'))`,
        );
        db.run(
            `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, status, created_at, updated_at)
             VALUES ('c:1', 'p', 'c', 1, 'hi', 'completed', datetime('now'), datetime('now'))`,
        );
        db.run(
            `INSERT INTO llm_call (id, project_id, request_id, call_index, file_line_no, tool_count, text_chars, emit_chars, created_at)
             VALUES ('lc1', 'p', 'c:1', 0, 1, 0, 10, 40, datetime('now'))`,
        );
        db.run(
            `INSERT INTO decision_ledger (id, project_id, request_id, event_type, jev_mode, enforced_verdict, ambiguous_policy, latency_ms_l0, latency_ms_jev, created_at)
             VALUES ('d1', 'p', 'c:1', 'turn_start', 'active', 'route_l0', 'hil_only', 0, 0, datetime('now'))`,
        );

        refreshRequestListCache(db, 'p', { requestIds: new Set(['c:1']) });

        const row = db.get(
            'SELECT list_emit_chars_sum AS emit, list_decision_verdict AS verdict FROM request WHERE id = ?',
            ['c:1'],
        );
        assert.equal(row.emit, 40);
        assert.equal(row.verdict, 'route_l0');
        db.close();
    });
});
