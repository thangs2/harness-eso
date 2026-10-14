import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeIngestDb, runIngestOnce } from '../packages/harness-observe-server/src/ingest.mjs';
import { rebuildTranscript } from '../packages/harness-observe-server/src/ingest-transcript.mjs';
import { openDb } from '../packages/harness-observe-server/src/observe-db.mjs';

const USER_LINE = JSON.stringify({
    role: 'user',
    message: {
        content: [
            {
                type: 'text',
                text: '<external_links>x</external_links><timestamp>Tue Oct 13 2026</timestamp><user_query>review the ticket</user_query>',
            },
        ],
    },
});
const ASSISTANT_LINE = JSON.stringify({
    role: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }] },
});

/** A user line that is injected context, not a prompt — it neither starts a request nor counts as a call. */
const contextLine = (chars) =>
    JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: `<external_links>${'c'.repeat(chars)}</external_links>` }] },
    });

/** A transcript with no boundary at all — stands in for content written before the prompt. */
const filler = (chars) =>
    `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'w'.repeat(chars) }] } })}\n`;

function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-seam-'));
    const transcriptDir = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, 'conv.jsonl');
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: 'seam-qc', displayName: 'seam QC' },
            ingest: { transcriptDir },
            storage: { driver: 'sqlite', sqlite: { path: dbPath } },
        }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({ version: 1, jev: { mode: 'off' }, ledger: { enabled: false }, eso: { enabled: false } }),
    );
    process.env.DEEPSEEK_USAGE_LEDGER = path.join(root, 'no-ledger.jsonl');
    return {
        transcript,
        dbPath,
        cfg: {
            ok: true,
            root,
            configPath: path.join(root, 'harness.config.json'),
            dataDir: path.join(root, '.harness'),
            project: { id: 'seam-qc', displayName: 'seam QC' },
            enabled: true,
            sentinelPath: path.join(root, '.harness', 'DISABLED'),
            storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
            server: { host: '127.0.0.1', port: 8792 },
            ingest: { pollMs: 2000, transcriptDir, hookFiles: [] },
            decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
        },
    };
}

const countRows = (dbPath) => {
    const db = openDb(dbPath);
    const out = {
        requests: db.get('SELECT COUNT(*) n FROM request').n,
        calls: db.get('SELECT COUNT(*) n FROM llm_call').n,
        requestCount: db.get('SELECT request_count FROM conversation')?.request_count ?? null,
    };
    db.close();
    return out;
};

/**
 * The cursor is a byte offset and used to be trusted whenever the file was not SHORTER than it. A
 * transcript rewritten in place to an equal-or-longer file therefore had its prompt skipped forever:
 * the pass read the tail from the stale offset, found no boundary (the prompt is before the cursor),
 * created nothing, then advanced the cursor to the new size.
 *
 * Seen on a real conversation: cursor at EOF, zero requests, zero llm_calls, `<user_query>` present in
 * the file — so the symptom is asserted directly, not inferred.
 */
test('a transcript rewritten in place to a LONGER file is rebuilt, not silently skipped', async () => {
    const { transcript, dbPath, cfg } = project();
    try {
        /*
         * The rewrite has to put the prompt BEFORE the stale cursor, or the test proves nothing: a
         * longer file that keeps the old prefix is just an append, and the cursor would land on the
         * boundary anyway. So the old content is a long filler, and the new content starts with the
         * prompt — leaving the cursor stranded past it, exactly as observed on the real conversation.
         *
         * It also has to be LONGER than the cursor, or the existing `size < last_offset` guard would
         * catch it and this would not be the dangerous case. Hence the trailing context line, which is
         * padding that neither starts a request nor counts as a call.
         */
        fs.writeFileSync(transcript, filler(400));
        await runIngestOnce(cfg);
        const before = countRows(dbPath);
        assert.equal(before.requests, 0, 'nothing to record yet');
        const db = openDb(dbPath);
        const cursor = db.get('SELECT last_offset, seam_hash FROM ingest_state');
        db.close();
        assert.ok(cursor.last_offset > 0, 'the cursor must have advanced');
        assert.ok(cursor.seam_hash, 'the seam must be recorded, or a rewrite is undetectable');
        assert.ok(
            cursor.last_offset > Buffer.byteLength(USER_LINE, 'utf8'),
            'the prompt must sit before the cursor, or this is not the dangerous case',
        );

        // Rewrite in place, longer, now containing the prompt. The size guard cannot see this.
        fs.writeFileSync(transcript, [USER_LINE, ASSISTANT_LINE, contextLine(900), ''].join('\n'));
        assert.ok(
            fs.statSync(transcript).size > cursor.last_offset,
            'the rewritten file must be larger, or the old guard would have caught it',
        );

        await runIngestOnce(cfg);
        const after = countRows(dbPath);
        assert.equal(after.requests, 1, 'the prompt in the rewritten file must not be lost');
        assert.equal(after.calls, 1, 'and its calls must be recorded');
        assert.equal(after.requestCount, 1);
    } finally {
        closeIngestDb();
    }
});

test('an unchanged file is not rebuilt on every pass', async () => {
    const { transcript, dbPath, cfg } = project();
    try {
        fs.writeFileSync(transcript, [USER_LINE, ASSISTANT_LINE, ''].join('\n'));
        await runIngestOnce(cfg);
        const first = countRows(dbPath);
        assert.equal(first.requests, 1);

        // A second pass with no new bytes must keep the same rows — a seam check that always failed
        // would delete and recreate them on every cycle.
        await runIngestOnce(cfg);
        assert.deepEqual(countRows(dbPath), first);
    } finally {
        closeIngestDb();
    }
});

test('appending still works and keeps the original request', async () => {
    const { transcript, dbPath, cfg } = project();
    try {
        fs.writeFileSync(transcript, [USER_LINE, ASSISTANT_LINE, ''].join('\n'));
        await runIngestOnce(cfg);

        fs.appendFileSync(transcript, `${ASSISTANT_LINE}\n`);
        await runIngestOnce(cfg);
        const after = countRows(dbPath);
        assert.equal(after.requests, 1, 'an append is not a rewrite');
        assert.equal(after.calls, 2);
    } finally {
        closeIngestDb();
    }
});

test('a cursor with no seam is caught when it does not sit on a line boundary', async () => {
    const { transcript, dbPath, cfg } = project();
    try {
        fs.writeFileSync(transcript, filler(250));
        await runIngestOnce(cfg);

        // Simulate a legacy cursor: no seam, and an offset in the middle of a line.
        const db = openDb(dbPath);
        const size = db.get('SELECT last_size FROM ingest_state').last_size;
        db.run('UPDATE ingest_state SET seam_hash = NULL, last_offset = ? WHERE source_kind = ?', [
            Math.floor(size / 2),
            'transcript',
        ]);
        db.close();

        fs.writeFileSync(transcript, [filler(250), USER_LINE, ASSISTANT_LINE, ''].join('\n'));
        await runIngestOnce(cfg);
        assert.equal(countRows(dbPath).requests, 1, 'a mid-line offset is not trustworthy');
    } finally {
        closeIngestDb();
    }
});

test('rebuild re-reads from the start and renumbers from 1', async () => {
    /*
     * The repair path for a cursor that predates `seam_hash`. Clearing the cursor alone would be
     * unsafe — numbering continues past the highest existing boundary index — which is why this
     * clears the derived rows first.
     */
    const { transcript, dbPath, cfg } = project();
    try {
        fs.writeFileSync(transcript, [USER_LINE, ASSISTANT_LINE, ''].join('\n'));
        await runIngestOnce(cfg);

        const db = openDb(dbPath);
        const r = rebuildTranscript(db, cfg, transcript);
        assert.equal(r.newRequests, 1);
        const ids = db.all('SELECT id FROM request').map((x) => x.id);
        assert.deepEqual(ids, ['conv:1'], 'numbering must restart at 1, not continue at 2');
        assert.equal(db.get('SELECT COUNT(*) n FROM llm_call').n, 1);
        db.close();
    } finally {
        closeIngestDb();
    }
});
