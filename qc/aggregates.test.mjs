import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootObserveDb, createObserveApp } from '@mu/harness-observe-server';
import { openDb, migrate, upsertProject } from '@mu/harness-observe-server';
import { aggregates } from '../packages/harness-observe-server/src/aggregates.mjs';
import { refreshMcpCallStats } from '../packages/harness-observe-server/src/mcp-call-stats.mjs';
import { assistantStats } from '../packages/harness-observe-server/src/ingest-transcript.mjs';

function makeConfig() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agg-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'agg-qc', displayName: 'Agg QC' },
            server: { host: '127.0.0.1', port: 0 },
            storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        }),
    );
    return {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'agg-qc', displayName: 'Agg QC' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8810 },
        ingest: { pollMs: 2000, transcriptDir: '/tmp', hookFiles: [] },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
}

function seedRequests(db, cfg) {
    migrate(db);
    upsertProject(db, cfg);
    const now = '2026-01-15T10:30:00Z';
    db.run(
        `INSERT INTO conversation (id, project_id, created_at, updated_at)
         VALUES ('c1', ?, ?, ?)`,
        [cfg.project.id, now, now],
    );
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, started_at, created_at, updated_at,
            call_count, tool_count, input_tokens, output_tokens, cache_read_tokens, has_failures, status)
         VALUES ('r1', ?, 'c1', 1, 'q1', ?, ?, ?, 2, 3, 100, 50, 10, 0, 'completed')`,
        [cfg.project.id, now, now, now],
    );
    const later = '2026-01-15T11:45:00Z';
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, started_at, created_at, updated_at,
            call_count, tool_count, input_tokens, output_tokens, cache_read_tokens, has_failures, status)
         VALUES ('r2', ?, 'c1', 2, 'q2', ?, ?, ?, 1, 1, 200, 80, 0, 1, 'completed')`,
        [cfg.project.id, later, later, later],
    );
    db.run(
        `INSERT INTO llm_call (id, project_id, request_id, call_index, file_line_no, tool_count, text_chars, emit_chars, tool_names, preview, created_at)
         VALUES ('r1:1', ?, 'r1', 1, 1, 1, 10, 20, 'ask_deepseek_flash', 'p', ?)`,
        [cfg.project.id, now],
    );
    refreshMcpCallStats(db, cfg.project.id, ['r1', 'r2']);
}

test('aggregates buckets hour grain', () => {
    const cfg = makeConfig();
    const db = openDb(cfg.storage.target);
    seedRequests(db, cfg);
    const url = new URL('http://127.0.0.1/api/aggregates?bucket=hour');
    const { buckets } = aggregates(db, cfg, url);
    assert.ok(buckets.length >= 1);
    const totalReq = buckets.reduce((a, b) => a + b.requests, 0);
    assert.equal(totalReq, 2);
    const sumIn = buckets.reduce((a, b) => a + b.inputTokens, 0);
    assert.equal(sumIn, 300);
    db.close();
});

test('GET /api/aggregates via HTTP handler', async () => {
    const cfg = makeConfig();
    bootObserveDb(cfg);
    const db = openDb(cfg.storage.target);
    seedRequests(db, cfg);
    db.close();

    const app = createObserveApp(cfg, { pollIngest: false });
    app.setPort(8811);

    const res = await app.handler(new Request('http://127.0.0.1/api/aggregates?bucket=day'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.buckets));
    assert.equal(body.buckets.reduce((a, b) => a + b.requests, 0), 2);
});

test('assistantStats parses OpenAI-style tool_calls', () => {
    const st = assistantStats({
        content: [{ type: 'text', text: 'hi' }],
        tool_calls: [{ type: 'function', function: { name: 'ask_deepseek_pro', arguments: '{"q":1}' } }],
    });
    assert.equal(st.tools, 1);
    assert.ok(st.names.includes('ask_deepseek_pro'));
});
