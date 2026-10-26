import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb, migrate, upsertProject } from '@mu/harness-observe-server';
import {
    ingestTranscript,
    parsePromptTs,
} from '../packages/harness-observe-server/src/ingest-transcript.mjs';
import { runIngestOnce } from '@mu/harness-observe-server';

const SAMPLE_TRANSCRIPT = [
    JSON.stringify({
        role: 'user',
        message: {
            content: [
                {
                    type: 'text',
                    text: '<timestamp>Mon Jan 1 2026</timestamp><user_query>hello harness qc</user_query>',
                },
            ],
        },
    }),
    JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
    }),
    '',
].join('\n');


/**
 * Every fixture gets its own directory.
 *
 * `transcriptDir` means "read every .jsonl in this directory", so pointing it at the shared temp
 * directory made each run ingest every transcript any earlier run had left there — 904 files and
 * five seconds per call on a developer machine, one file and milliseconds on a clean one. The
 * symptom looked like a flaky timeout; the cause was tests sharing a global directory.
 */
function fixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-transcript-'));
    return dir;
}

function transcriptIn(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

function consumerWithTranscript(transcriptPath) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ingest-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, SAMPLE_TRANSCRIPT, 'utf8');
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'ingest-qc', displayName: 'Ingest QC' },
            ingest: { transcriptDir: path.dirname(transcriptPath) },
            storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        }),
    );
    return {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir: path.join(root, '.harness'),
        project: { id: 'ingest-qc', displayName: 'Ingest QC' },
        enabled: true,
        sentinelPath: path.join(root, '.harness', 'DISABLED'),
        storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
        server: { host: '127.0.0.1', port: 8792 },
        ingest: {
            pollMs: 2000,
            transcriptDir: path.dirname(transcriptPath),
            hookFiles: [],
        },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
}

test('ingestTranscript creates one request and one llm_call', () => {
    const transcriptPath = transcriptIn(fixtureDir(), `qc-transcript-${Date.now()}.jsonl`);
    const cfg = consumerWithTranscript(transcriptPath);
    const db = openDb(cfg.storage.target);
    migrate(db);
    upsertProject(db, cfg);
    const out = ingestTranscript(db, cfg, transcriptPath);
    assert.equal(out.ok, true);
    assert.ok(out.newRequests >= 1);
    const req = db.get('SELECT COUNT(*) AS n FROM request WHERE project_id = ?', [cfg.project.id]);
    const calls = db.get('SELECT COUNT(*) AS n FROM llm_call WHERE project_id = ?', [cfg.project.id]);
    assert.ok(req.n >= 1);
    assert.ok(calls.n >= 1);
    db.close();
});

test('parsePromptTs applies the annotated zone, not the process timezone', () => {
    // Ingest runs in the observe container (TZ=UTC) while the operator may be UTC+7.
    // Interpreting the wall clock in the PROCESS zone recorded prompts 7h in the future
    // and broke every `started_at` window join.
    assert.equal(parsePromptTs('Monday, Oct 12, 2026, 6:00 PM (UTC+7)'), '2026-10-12T11:00:00Z');
    assert.equal(parsePromptTs('Monday, Oct 12, 2026, 6:00 PM (UTC+0)'), '2026-10-12T18:00:00Z');
    assert.equal(parsePromptTs('Monday, Oct 12, 2026, 6:00 PM (UTC-5)'), '2026-10-12T23:00:00Z');
    assert.equal(parsePromptTs('Monday, Oct 12, 2026, 6:00 PM (UTC+05:30)'), '2026-10-12T12:30:00Z');
    // No annotation: treat as UTC rather than guessing from the host clock.
    assert.equal(parsePromptTs('Monday, Oct 12, 2026, 6:00 PM'), '2026-10-12T18:00:00Z');
    assert.equal(parsePromptTs('not a timestamp'), null);
    assert.equal(parsePromptTs(''), null);
});

test('ingestTranscript stores started_at as true UTC for a zoned prompt', () => {
    const transcriptPath = transcriptIn(fixtureDir(), `qc-transcript-tz-${Date.now()}.jsonl`);
    const cfg = consumerWithTranscript(transcriptPath);
    // consumerWithTranscript seeds a sample transcript; replace it with the zoned prompt.
    fs.writeFileSync(
        transcriptPath,
        [
            JSON.stringify({
                role: 'user',
                message: {
                    content: [
                        {
                            type: 'text',
                            text: '<timestamp>Monday, Oct 12, 2026, 6:00 PM (UTC+7)</timestamp><user_query>tz check</user_query>',
                        },
                    ],
                },
            }),
            JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
            '',
        ].join('\n'),
        'utf8',
    );
    const db = openDb(cfg.storage.target);
    migrate(db);
    upsertProject(db, cfg);
    ingestTranscript(db, cfg, transcriptPath);
    const row = db.get('SELECT started_at FROM request WHERE project_id = ?', [cfg.project.id]);
    assert.equal(row.started_at, '2026-10-12T11:00:00Z');
    db.close();
});

test('runIngestOnce twice does not duplicate requests', async () => {
    const transcriptPath = transcriptIn(fixtureDir(), `qc-transcript-${Date.now()}-2.jsonl`);
    const cfg = consumerWithTranscript(transcriptPath);
    const prevFacade = process.env.HARNESS_DECISION_FACADE;
    const prevEso = process.env.HARNESS_ESO;
    process.env.HARNESS_DECISION_FACADE = '0';
    process.env.HARNESS_ESO = '0';
    try {
        const a = await runIngestOnce(cfg, { force: true });
        const b = await runIngestOnce(cfg, { force: true });
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.equal(a.counts.requests, b.counts.requests);
        assert.ok(a.counts.requests >= 1);
    } finally {
        if (prevFacade === undefined) delete process.env.HARNESS_DECISION_FACADE;
        else process.env.HARNESS_DECISION_FACADE = prevFacade;
        if (prevEso === undefined) delete process.env.HARNESS_ESO;
        else process.env.HARNESS_ESO = prevEso;
    }
});

test('ingestTranscript correctly ingests Claude Code JSONL turn structure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-ingest-'));
    const claudeDir = path.join(root, '.claude', 'projects', '-Users-test-myproject');
    fs.mkdirSync(claudeDir, { recursive: true });
    const transcriptPath = path.join(claudeDir, 'session-abc.jsonl');

    const claudeLines = [
        JSON.stringify({
            type: 'user',
            timestamp: '2026-10-16T15:00:00.000Z',
            cwd: '/Users/test/myproject',
            message: {
                role: 'user',
                content: '<USER_REQUEST>Implement feature X</USER_REQUEST>',
            },
        }),
        JSON.stringify({
            type: 'assistant',
            timestamp: '2026-10-16T15:00:05.000Z',
            message: {
                role: 'assistant',
                model: 'claude-3-7-sonnet-20250219',
                content: [
                    { type: 'text', text: 'I will inspect the files.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'Bash',
                        input: { command: 'git status' },
                    },
                    {
                        type: 'tool_use',
                        id: 'toolu_2',
                        name: 'Read',
                        input: { file_path: 'AGENTS.md' },
                    },
                ],
                usage: {
                    input_tokens: 1200,
                    output_tokens: 150,
                    cache_read_input_tokens: 3500,
                    cache_creation_input_tokens: 250,
                },
            },
        }),
        JSON.stringify({
            type: 'turn_ended',
            status: 'completed',
        }),
    ].join('\n');

    fs.writeFileSync(transcriptPath, claudeLines, 'utf8');

    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const cfg = {
        ok: true,
        root: '/Users/test/myproject',
        configPath: path.join(root, 'harness.config.json'),
        project: { id: 'claude-qc', displayName: 'Claude QC' },
        storage: { driver: 'sqlite', target: dbPath },
        ingest: {
            pollMs: 2000,
            claudeProjectsDirs: [path.join(root, '.claude', 'projects')],
            hookFiles: [],
        },
    };

    const db = openDb(cfg.storage.target);
    migrate(db);
    upsertProject(db, cfg);

    const out = ingestTranscript(db, cfg, transcriptPath);
    assert.equal(out.ok, true);
    assert.equal(out.newRequests, 1);
    assert.equal(out.newCalls, 1);

    const req = db.get('SELECT * FROM request WHERE project_id = ?', [cfg.project.id]);
    assert.ok(req);
    assert.equal(req.user_query, 'Implement feature X');
    assert.equal(req.input_tokens, 1200);
    assert.equal(req.output_tokens, 150);
    assert.equal(req.cache_read_tokens, 3500);
    assert.equal(req.cache_write_tokens, 250);
    assert.equal(req.model_id, 'claude-3-7-sonnet-20250219');

    const events = db.all('SELECT * FROM event WHERE project_id = ? ORDER BY id ASC', [cfg.project.id]);
    assert.equal(events.length, 2);
    assert.equal(events[0].tool, 'Bash');
    assert.equal(events[0].harness, 'claude');
    assert.equal(events[1].tool, 'Read');
    assert.equal(events[1].path, 'AGENTS.md');

    const rules = db.all('SELECT * FROM request_rule WHERE request_id = ?', [req.id]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule_id, 'AGENTS.md');

    db.close();
});

