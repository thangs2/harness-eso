import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeChecks } from '../packages/harness-observe-server/src/checks.mjs';
import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';

const PROJECT = 'diet-qc';
const CONV = 'conv-diet-1';
const GEN = 'gen-diet-1234';

function fixture({ policyPatch = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-diet-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    const policyPath = path.join(root, '.harness', 'decision-policy.json');
    fs.writeFileSync(
        policyPath,
        JSON.stringify({
            version: 1,
            tokenDiet: {
                enabled: true,
                maxEagerRules: 7,
                maxEagerTokens: 5000,
                ...policyPatch,
            },
        }),
    );
    const cfg = {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: PROJECT, displayName: PROJECT },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8792 },
        ingest: { pollMs: 2000, transcriptDir: '', hookFiles: [] },
        registry: { mode: 'isolated', registry: '' },
        decisionPolicyPath: policyPath,
    };
    const db = openDb(dbPath);
    migrate(db);
    upsertProject(db, cfg);
    db.run(
        `INSERT INTO conversation (id, project_id, started_at, ended_at, request_count, created_at, updated_at)
         VALUES (?, ?, '2026-10-14T11:57:00Z', '2026-10-14T11:58:37Z', 1,
                 '2026-10-14T11:57:00Z', '2026-10-14T11:58:37Z')
         ON CONFLICT(id) DO NOTHING`,
        [CONV, PROJECT],
    );
    return { cfg, db };
}

function seedTurn(db, requestId, rulesCount) {
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
            started_at, status, generation_id, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'query', 'Wed Oct 14 2026', '2026-10-14T11:57:00Z', 'completed', ?,
                 '2026-10-14T11:57:00Z', '2026-10-14T11:58:37Z')`,
        [requestId, PROJECT, CONV, GEN],
    );
    db.run('INSERT INTO request_tool (request_id, tool, count) VALUES (?, ?, ?)', [requestId, 'Read', 1]);
    db.run(
        `INSERT INTO event (project_id, harness, event_type, tool, generation_id, conversation_id,
            request_id, hook_at, source_path, source_line_no, raw_json)
         VALUES (?, 'cursor', 'beforeSubmitPrompt', '', ?, ?, ?, ?, 'hooks.jsonl', 1, '{}')`,
        [PROJECT, GEN, CONV, requestId, '2026-10-14T11:57:54Z'],
    );
    db.run(
        `INSERT INTO hook_prompt (project_id, generation_id, conversation_id, prompt_text, rules_json, hook_at)
         VALUES (?, ?, ?, 'query', '[]', '2026-10-14T11:57:54Z')`,
        [PROJECT, GEN, CONV],
    );
    for (let i = 0; i < rulesCount; i += 1) {
        db.run(
            `INSERT INTO request_rule (request_id, rule_id, attached_at) VALUES (?, ?, '2026-10-14T11:57:54Z')`,
            [requestId, `rule-${i + 1}.mdc`],
        );
    }
}

test('eager-prefix-budget passes when rules attached <= maxEagerRules', () => {
    const { cfg, db } = fixture();
    const reqId = `${CONV}:1`;
    try {
        seedTurn(db, reqId, 5); // 5 rules <= 7
        computeChecks(db, cfg, null);

        const row = db.get(
            'SELECT status, heuristic, detail FROM check_result WHERE request_id = ? AND check_id = ?',
            [reqId, 'eager-prefix-budget'],
        );
        assert.ok(row, 'check_result row must exist');
        assert.equal(row.status, 'pass');
        assert.equal(row.heuristic, 0);
        assert.match(row.detail, /5 eager rule\(s\) attached within budget/);
    } finally {
        db.close();
    }
});

test('eager-prefix-budget warns when rules attached > maxEagerRules', () => {
    const { cfg, db } = fixture();
    const reqId = `${CONV}:2`;
    try {
        seedTurn(db, reqId, 8); // 8 rules > 7
        computeChecks(db, cfg, null);

        const row = db.get(
            'SELECT status, heuristic, detail FROM check_result WHERE request_id = ? AND check_id = ?',
            [reqId, 'eager-prefix-budget'],
        );
        assert.ok(row, 'check_result row must exist');
        assert.equal(row.status, 'warn');
        assert.equal(row.heuristic, 1);
        assert.match(row.detail, /eager prefix exceeds budget: 8 rules attached \(budget <= 7\)/);
    } finally {
        db.close();
    }
});

test('eager-prefix-budget skips when disabled in policy', () => {
    const { cfg, db } = fixture({ policyPatch: { enabled: false } });
    const reqId = `${CONV}:3`;
    try {
        seedTurn(db, reqId, 10);
        computeChecks(db, cfg, null);

        const row = db.get(
            'SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?',
            [reqId, 'eager-prefix-budget'],
        );
        assert.equal(row.status, 'skip');
        assert.match(row.detail, /disabled in policy/);
    } finally {
        db.close();
    }
});
