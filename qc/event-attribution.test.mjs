import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linkRequests } from '../packages/harness-observe-server/src/ingest-hooks.mjs';
import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';

const PROJECT = 'attr-qc';
const CONV = 'conv-1';
/** Real generation ids, as Cursor issues them: bare UUIDs, distinct per turn. */
const GEN_OLD = '361d7f31-cd30-40aa-9c11-111111111111';
const GEN_NEW = '70dea39c-97d0-49bb-8c22-222222222222';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-attr-'));
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
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
        tenancy: { mode: 'isolated', registry: '' },
        decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
    };
    const db = openDb(dbPath);
    migrate(db);
    upsertProject(db, cfg);
    db.run(
        `INSERT INTO conversation (id, project_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`,
        [CONV, PROJECT],
    );
    return { db, cfg };
}

/** A request as transcript ingest creates it: id `<conv>:<n>`, timestamp minute-rounded. */
function addRequest(db, n, { startedAt, query, generationId = null }) {
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
            started_at, status, generation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Mon Oct 13 2026', ?, 'completed', ?, datetime('now'), datetime('now'))`,
        [`${CONV}:${n}`, PROJECT, CONV, n, query, startedAt, generationId],
    );
}

/** A captured prompt, as the `beforeSubmitPrompt` hook writes it. */
function addPrompt(db, { generationId, at, text }) {
    db.run(
        `INSERT INTO hook_prompt (project_id, generation_id, conversation_id, prompt_text, rules_json, hook_at)
         VALUES (?, ?, ?, ?, '[]', ?)
         ON CONFLICT(project_id, generation_id) DO UPDATE SET hook_at = excluded.hook_at, prompt_text = excluded.prompt_text`,
        [PROJECT, generationId, CONV, text, at],
    );
}

/** A hook event, with the generation the IDE stamped on it. */
function addEvent(db, { generationId, at, tool, eventType = 'postToolUse' }) {
    db.run(
        `INSERT INTO event (project_id, harness, event_type, tool, path, generation_id, conversation_id,
            request_id, hook_at, source_path, source_line_no, raw_json)
         VALUES (?, 'cursor', ?, ?, '', ?, ?, NULL, ?, 'route-trace.jsonl', ?, '{}')`,
        [PROJECT, eventType, tool, generationId, CONV, at, Math.floor(Math.random() * 1e6)],
    );
}

const eventRequest = (db, tool) =>
    db.get('SELECT request_id FROM event WHERE project_id = ? AND tool = ?', [PROJECT, tool]).request_id;

/**
 * The race this fixes.
 *
 * Hooks are written by the IDE as calls happen; requests come from the transcript on a ~15s poll. A tool
 * event therefore routinely exists **before** the turn it belongs to has a row. The turn-window fallback
 * then files it under the previous request in the conversation, and the old generation rule only filled
 * `request_id IS NULL` — so when the transcript caught up and the prompt was linked, nothing revisited
 * the event.
 *
 * Measured on x79: 3,438 events whose generation conflicted with the generation of the request they were
 * filed under, across 7 conversations. The user-visible form was a turn showing 2 of its 21 tool calls,
 * with its file edits and a protected-write check attributed to the previous turn.
 */
test('an event filed under the wrong turn is re-attributed once its turn exists', () => {
    const { db, cfg } = fixture();
    try {
        // Pass 1 — the earlier turn is known; the new turn has not been ingested yet.
        addRequest(db, 3, { startedAt: '2026-10-13T13:40:00Z', query: 'implement ticket', generationId: GEN_OLD });
        addPrompt(db, { generationId: GEN_OLD, at: '2026-10-13T13:40:23Z', text: 'implement ticket' });
        // The new turn's tool event is already on disk, stamped with ITS generation.
        addEvent(db, { generationId: GEN_NEW, at: '2026-10-13T17:27:42Z', tool: 'Grep' });

        linkRequests(db, cfg);
        assert.equal(
            eventRequest(db, 'Grep'),
            `${CONV}:3`,
            'sanity: with no turn to claim it, the window fallback files it under the previous turn',
        );

        // Pass 2 — the transcript catches up, bringing the new turn and its captured prompt.
        addRequest(db, 4, { startedAt: '2026-10-13T17:27:00Z', query: 're-work', generationId: null });
        addPrompt(db, { generationId: GEN_NEW, at: '2026-10-13T17:27:13Z', text: 're-work' });

        const out = linkRequests(db, cfg);
        assert.equal(out.linked, 1, 'the prompt links to the new turn');
        assert.equal(
            eventRequest(db, 'Grep'),
            `${CONV}:4`,
            'and the event moves: its own generation is first-hand evidence, a time guess is not',
        );
        assert.equal(out.corrected, 1, 'the correction is reported, so the cycle can rebuild derived data');
        assert.ok(out.repaired >= 1, 'a correction counts as a repair and forces a full recompute');
    } finally {
        db.close();
    }
});

test('the correction is a no-op once converged', () => {
    /*
     * `repaired > 0` forces a full recompute of every request's files, tools and checks. If the corrective
     * update rewrote identical rows it would report a change on every pass and pin the ingest loop to the
     * expensive path forever — so the guard on differing values is load-bearing, not an optimisation.
     *
     * Note this pass legitimately assigns on the first run without counting as a *correction*: the earlier
     * generation-based fill reaches an event that has no `request_id` yet. The property under test is the
     * converged pass, not which step did the first assignment.
     */
    const { db, cfg } = fixture();
    try {
        // As the transcript creates it: no generation yet. The prompt link is what supplies it.
        addRequest(db, 4, { startedAt: '2026-10-13T17:27:00Z', query: 're-work', generationId: null });
        addPrompt(db, { generationId: GEN_NEW, at: '2026-10-13T17:27:13Z', text: 're-work' });
        addEvent(db, { generationId: GEN_NEW, at: '2026-10-13T17:27:42Z', tool: 'Read' });

        const first = linkRequests(db, cfg);
        assert.equal(first.linked, 1, 'the prompt links the turn');
        assert.equal(eventRequest(db, 'Read'), `${CONV}:4`, 'and the event is attributed to it');

        const second = linkRequests(db, cfg);
        assert.equal(second.corrected, 0, 'a converged pass must find nothing to change');
        assert.equal(second.repaired, 0, 'so it must not force a full recompute');
        assert.equal(second.linked, 0, 'and must not relink');
        assert.equal(eventRequest(db, 'Read'), `${CONV}:4`, 'the attribution is stable');
    } finally {
        db.close();
    }
});

test('a correctly attributed event is left alone', () => {
    // The common case must not churn: an event already on the right turn is not rewritten.
    const { db, cfg } = fixture();
    try {
        addRequest(db, 1, { startedAt: '2026-10-13T13:33:00Z', query: 'review', generationId: GEN_OLD });
        addPrompt(db, { generationId: GEN_OLD, at: '2026-10-13T13:33:53Z', text: 'review' });
        addEvent(db, { generationId: GEN_OLD, at: '2026-10-13T13:34:10Z', tool: 'Read' });

        const out = linkRequests(db, cfg);
        assert.equal(eventRequest(db, 'Read'), `${CONV}:1`);
        assert.equal(out.corrected, 0);
    } finally {
        db.close();
    }
});

test('an event with no generation still falls back to the turn window', () => {
    // The fallback is still needed: not every hook event carries a generation, and those have only time
    // as a signal. Making the generation rule authoritative must not remove the fallback.
    const { db, cfg } = fixture();
    try {
        addRequest(db, 1, { startedAt: '2026-10-13T13:33:00Z', query: 'review', generationId: GEN_OLD });
        addPrompt(db, { generationId: GEN_OLD, at: '2026-10-13T13:33:53Z', text: 'review' });
        addEvent(db, { generationId: null, at: '2026-10-13T13:34:10Z', tool: 'Shell' });

        linkRequests(db, cfg);
        assert.equal(eventRequest(db, 'Shell'), `${CONV}:1`, 'placed by its window');
    } finally {
        db.close();
    }
});
