import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linkRequests } from '../packages/harness-observe-server/src/ingest-hooks.mjs';
import { computeChecks } from '../packages/harness-observe-server/src/checks.mjs';
import { hasRealGenerationLink } from '../packages/harness-observe-server/src/ag-request-enrich.mjs';
import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';

const PROJECT = 'link-qc';
const CONV = 'conv-1';
/** A real Cursor generation id: a bare UUID, never equal to a `<uuid>:<n>` request id. */
const GEN = '549a62a4-8ee8-4093-8f24-8df1585d0fab';
const QUERY = 'hãy kiểm tra ticket https://example.atlassian.net/browse/X79-166';
const RULES = ['AGENTS.md', 'core.agent-pipeline.mdc', 'core.pipeline-gate.mdc'];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-link-'));
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
        `INSERT INTO conversation (id, project_id, started_at, ended_at, request_count, created_at, updated_at)
         VALUES (?, ?, '2026-10-13T11:57:00Z', '2026-10-13T11:58:37Z', 1,
                 '2026-10-13T11:57:00Z', '2026-10-13T11:58:37Z')
         ON CONFLICT(id) DO NOTHING`,
        [CONV, PROJECT],
    );
    return { cfg, db };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ requestId: string, generationId: string | null }} opts
 */
function seedRequest(db, { requestId, generationId }) {
    // `boundary_index` is unique per conversation, so derive it from the `<conv>:<n>` request id.
    const boundary = Number(String(requestId).split(':').pop()) || 1;
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
            started_at, status, generation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Tue Oct 13 2026', '2026-10-13T11:57:00Z', 'completed', ?,
                 '2026-10-13T11:57:00Z', '2026-10-13T11:57:00Z')`,
        [requestId, PROJECT, CONV, boundary, QUERY, generationId],
    );
}

/** The captured prompt, exactly as the `beforeSubmitPrompt` hook writes it. */
function seedHookPrompt(db, hookAt = '2026-10-13T11:57:54Z') {
    db.run(
        `INSERT INTO hook_prompt (project_id, generation_id, conversation_id, prompt_text, rules_json, hook_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, generation_id) DO UPDATE SET
             prompt_text = excluded.prompt_text, rules_json = excluded.rules_json, hook_at = excluded.hook_at`,
        [PROJECT, GEN, CONV, QUERY, JSON.stringify(RULES), hookAt],
    );
}

/**
 * `backfillAntigravityGenerationIds` used to run FIRST in `linkRequests` and write `generation_id = id`
 * for every request. Because the link guard tested `generation_id IS NOT NULL`, the placeholder read as
 * "this turn already has a captured prompt", so **no prompt could ever be linked**. `request_rule`
 * stayed empty for the whole project and every attachment check reported "was not captured" while the
 * rules sat in the hook events.
 *
 * The test seeds the poisoned state that exists in production (3236 of 3236 requests carry the
 * placeholder) and asserts that a captured prompt still links.
 */
test('a captured prompt links even when the request already carries the placeholder', () => {
    const { cfg, db } = fixture();
    try {
        const requestId = `${CONV}:1`;
        // Placeholder already stamped, as every existing row has.
        seedRequest(db, { requestId, generationId: requestId });
        seedHookPrompt(db);

        const out = linkRequests(db, cfg);
        assert.equal(out.linked, 1, 'the prompt must be linked, not skipped as "already accounted for"');
        assert.deepEqual(out.linkedRequestIds, [requestId], 'linkedRequestIds must report which requests were linked');

        const req = db.get('SELECT id, generation_id FROM request WHERE id = ?', [requestId]);
        assert.equal(req.generation_id, GEN, 'the real generation id must replace the placeholder');

        const rules = db.all('SELECT rule_id FROM request_rule WHERE request_id = ? ORDER BY rule_id', [requestId]);
        assert.deepEqual(
            rules.map((r) => r.rule_id),
            [...RULES].sort(),
            'the attached rules must be projected into request_rule — this is what the UI and checks read',
        );
    } finally {
        db.close();
    }
});

test('a linked turn is not relinked on the next cycle', () => {
    const { cfg, db } = fixture();
    try {
        const requestId = `${CONV}:1`;
        seedRequest(db, { requestId, generationId: requestId });
        seedHookPrompt(db);

        assert.equal(linkRequests(db, cfg).linked, 1);
        // A second pass must be a no-op: the link is now real, so the guard applies as intended.
        assert.equal(linkRequests(db, cfg).linked, 0, 'a real link must not be re-applied');
        assert.equal(db.get('SELECT COUNT(*) n FROM request_rule').n, RULES.length, 'and must not duplicate rules');
        assert.equal(
            db.get('SELECT generation_id FROM request WHERE id = ?', [requestId]).generation_id,
            GEN,
            'the real link must survive',
        );
    } finally {
        db.close();
    }
});

test('a turn with no captured prompt still gets a placeholder, and stays linkable', () => {
    /*
     * The placeholder exists so the spine has a join key for turns with no hook trace. It must still
     * be written — and must NOT be mistaken for a real link, or the prompt captured later (the prompt
     * hook can be installed after the stop hook) could never attach.
     */
    const { cfg, db } = fixture();
    try {
        const requestId = `${CONV}:1`;
        seedRequest(db, { requestId, generationId: null });

        linkRequests(db, cfg);
        const req = db.get('SELECT id, generation_id FROM request WHERE id = ?', [requestId]);
        assert.equal(req.generation_id, requestId, 'the placeholder is still written');
        assert.equal(hasRealGenerationLink(req), false, 'but it must not read as a real link');

        // The prompt arrives later; the turn must still be linkable.
        seedHookPrompt(db);
        assert.equal(linkRequests(db, cfg).linked, 1, 'a later-captured prompt must still link');
        assert.equal(db.get('SELECT generation_id FROM request WHERE id = ?', [requestId]).generation_id, GEN);
    } finally {
        db.close();
    }
});

test('linking is what makes the attachment check able to judge', () => {
    /*
     * The check reads `request_rule`, which only linking populates. Before this, the check
     * permanently reported "prompt attachment was not captured — cannot judge" — a statement that was
     * not just unhelpful but false, since the captured prompt was sitting in `hook_prompt` the whole
     * time. Asserting the check here, rather than only `request_rule`, covers the wiring from the link
     * to the verdict the UI shows.
     */
    const requestId = `${CONV}:1`;
    const { cfg, db } = fixture();
    try {
        seedRequest(db, { requestId, generationId: requestId });
        // Tool activity, or the check short-circuits on "no tool activity recorded".
        db.run('INSERT INTO request_tool (request_id, tool, count) VALUES (?, ?, ?)', [requestId, 'Read', 1]);
        // And at least one event, or the module bails out earlier with "no hook evidence" for every
        // check — a different skip, which would make this assertion pass for the wrong reason.
        db.run(
            `INSERT INTO event (project_id, harness, event_type, tool, generation_id, conversation_id,
                request_id, hook_at, source_path, source_line_no, raw_json)
             VALUES (?, 'cursor', 'beforeSubmitPrompt', '', ?, ?, ?, ?, 'hooks.jsonl', 1, '{}')`,
            [PROJECT, GEN, CONV, requestId, '2026-10-13T11:57:54Z'],
        );
        seedHookPrompt(db);

        // Before linking the prompt, the check cannot judge — the rules are not in `request_rule` yet.
        computeChecks(db, cfg, { requestIds: [requestId], generations: [] });
        assert.equal(
            db.get('SELECT status FROM check_result WHERE request_id = ? AND check_id = ?', [requestId, 'rules-attached'])
                .status,
            'skip',
            'unlinked: nothing to judge',
        );

        linkRequests(db, cfg);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            requestId,
            'rules-attached',
        ]);
        assert.equal(row.status, 'pass', 'after linking, the attached rules must be judged, not skipped');
        assert.match(row.detail, new RegExp(`^${RULES.length} rule\\(s\\) attached`));
    } finally {
        db.close();
    }
});

test('a deadline-free text match is refused when ambiguous', () => {
    // Two turns with the same text and no usable clock: guessing would attach the prompt to the wrong
    // turn, which is the failure mode this whole function exists to avoid.
    const { cfg, db } = fixture();
    try {
        seedRequest(db, { requestId: `${CONV}:1`, generationId: null });
        db.run('UPDATE request SET started_at = NULL');
        seedRequest(db, { requestId: `${CONV}:2`, generationId: null });
        db.run('UPDATE request SET started_at = NULL');
        db.run('UPDATE hook_prompt SET hook_at = NULL');
        seedHookPrompt(db);
        db.run('UPDATE hook_prompt SET hook_at = NULL');

        const out = linkRequests(db, cfg);
        assert.equal(out.linked, 0, 'an ambiguous match must not be guessed');
        assert.equal(db.get('SELECT COUNT(*) n FROM request_rule').n, 0);
    } finally {
        db.close();
    }
});
