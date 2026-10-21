import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestHookFile } from '../packages/harness-observe-server/src/ingest-hooks.mjs';
import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';

const PROJECT = 'hook-rewrite-qc';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-rewrite-'));
    const dataDir = path.join(root, '.harness');
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = {
        ok: true,
        root,
        configPath: path.join(root, 'harness.config.json'),
        dataDir,
        project: { id: PROJECT, displayName: PROJECT },
        enabled: true,
        sentinelPath: path.join(dataDir, 'DISABLED'),
        storage: { driver: 'sqlite', target: path.join(dataDir, 'harness.db'), remoteUrl: null },
        server: { host: '127.0.0.1', port: 8792 },
        ingest: { pollMs: 2000, transcriptDir: '', hookFiles: [] },
        tenancy: { mode: 'isolated', registry: '' },
        decisionPolicyPath: path.join(dataDir, 'decision-policy.json'),
    };
    const db = openDb(cfg.storage.target);
    migrate(db);
    upsertProject(db, cfg);
    const hookPath = path.join(root, '.cursor', 'session', 'route-trace.jsonl');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    return { root, cfg, db, hookPath };
}

/** One trace line, shaped the way `route-hook.py` writes it. */
function line(at, file) {
    return JSON.stringify({
        at,
        event: 'postToolUse',
        tool: 'Read',
        path: file,
        attachments: [],
        ruleFiles: [],
        payload: { generation_id: 'g1', conversation_id: 'c1', tool_name: 'Read', tool_input: { file_path: file } },
        generationId: 'g1',
        conversationId: 'c1',
    });
}

const count = (db) => db.get('SELECT COUNT(*) AS n FROM event WHERE project_id = ?', [PROJECT]).n;
const paths = (db) => db.all('SELECT path FROM event WHERE project_id = ? ORDER BY id', [PROJECT]).map((r) => r.path);

test('a hook trace rewritten in place is re-read, not skipped from a stale cursor', () => {
    const { cfg, db, hookPath } = fixture();
    try {
        // Two lines; the cursor ends at EOF.
        fs.writeFileSync(hookPath, `${line('2026-10-19T10:20:00Z', '/repo/first.ts')}\n${line('2026-10-19T10:21:00Z', '/repo/second.ts')}\n`);
        ingestHookFile(db, cfg, hookPath);
        assert.equal(count(db), 2);

        /*
         * Rewrite the file in place with a LONGER body whose first line changed. `size < last_offset`
         * no longer fires, so without the seam check the pass would read only the tail and the first
         * line would never be stored — permanently.
         */
        const rewritten = [
            line('2026-10-19T10:20:30Z', '/repo/rewritten.ts'),
            line('2026-10-19T10:21:00Z', '/repo/second.ts'),
            line('2026-10-19T10:22:00Z', '/repo/third.ts'),
        ].join('\n');
        fs.writeFileSync(hookPath, `${rewritten}\n`);
        ingestHookFile(db, cfg, hookPath);

        assert.equal(count(db), 3, 'the rewrite must be rebuilt, not appended from a stale offset');
        assert.deepEqual(paths(db), ['/repo/rewritten.ts', '/repo/second.ts', '/repo/third.ts']);
    } finally {
        db.close();
    }
});

test('an ordinary append keeps the existing rows', () => {
    const { cfg, db, hookPath } = fixture();
    try {
        fs.writeFileSync(hookPath, `${line('2026-10-19T10:20:00Z', '/repo/first.ts')}\n`);
        ingestHookFile(db, cfg, hookPath);
        fs.appendFileSync(hookPath, `${line('2026-10-19T10:21:00Z', '/repo/second.ts')}\n`);
        const report = ingestHookFile(db, cfg, hookPath);

        assert.equal(report.rebuilt, false);
        assert.equal(count(db), 2);
    } finally {
        db.close();
    }
});
