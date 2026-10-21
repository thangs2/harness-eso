import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeChecks } from '../packages/harness-observe-server/src/checks.mjs';
import { overlayEvidence } from '../packages/harness-observe-server/src/ingest-hooks.mjs';
import {
    shellCommandOf,
    shellHasWriteIntent,
    shellWriteTargets,
} from '../packages/harness-foundation/src/pure.mjs';
import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'shell-write-qc';
const CONV = 'conv-1';
const REQ = `${CONV}:1`;

/** A Shell event, shaped the way `route-hook.py` writes it. */
function shellEvent(command, filePath) {
    return {
        raw_json: JSON.stringify({ at: '2026-10-13T13:42:41Z', event: 'postToolUse', tool: 'Shell', tool_input: { command } }),
        path: filePath,
        tool: 'Shell',
    };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shell-write-'));
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
    /*
     * Declare `paths`, like a real consumer does. Without it the product defaults apply — and those no
     * longer include `sdlc/`, deliberately: `sdlc/` is a working tree, not a source of truth to gate.
     * A fixture that relied on the default would be testing the product's defaults, not this logic.
     */
    fs.writeFileSync(
        cfg.decisionPolicyPath,
        JSON.stringify({
            version: 1,
            paths: {
                locked: ['document/mu/be/00.law/'],
                gated: ['document/mu/', 'scripts/ci/', '.cursor/rules/'],
                ask: ['sdlc/08.wbs/'],
                sot: ['document/mu/', 'sdlc/08.wbs/'],
            },
        }),
    );
    const db = openDb(dbPath);
    migrate(db);
    upsertProject(db, cfg);
    db.run(
        `INSERT INTO conversation (id, project_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`,
        [CONV, PROJECT],
    );
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'implement the ticket', 'completed', datetime('now'), datetime('now'))`,
        [REQ, PROJECT, CONV],
    );
    return { db, cfg };
}

/** Insert one event row for the request, so the checks have something to read. */
function addEvent(db, event) {
    db.run(
        `INSERT INTO event (project_id, harness, event_type, tool, path, generation_id, conversation_id,
            request_id, hook_at, source_path, source_line_no, raw_json)
         VALUES (?, 'cursor', ?, ?, ?, 'gen-1', ?, ?, '2026-10-13T13:42:41Z', 'route-trace.jsonl', ?, ?)`,
        [
            PROJECT,
            event.eventType ?? 'postToolUse',
            event.tool ?? '',
            event.path ?? '',
            CONV,
            REQ,
            Math.floor(Math.random() * 1e6),
            event.raw_json ?? '{}',
        ],
    );
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test('a command that writes is recognised as a write', () => {
    const writes = [
        ['cat > protected/file.md', 'protected/file.md'],
        ['cat >> log.md', 'log.md'],
        ['echo x > out.txt', 'out.txt'],
        ['cp a.sh b.sh', 'b.sh'],
        ['mv a.md b.md', 'b.md'],
        ['sed -i "s/a/b/" src/a.ts', 'src/a.ts'],
        ['touch new.md', 'new.md'],
        ['nohup node x.mjs > /tmp/a.log 2>&1 &', '/tmp/a.log'],
    ];
    for (const [cmd, expect] of writes) {
        assert.equal(shellHasWriteIntent(cmd), true, `${cmd} must read as a write`);
        assert.ok(shellWriteTargets(cmd).includes(expect), `${cmd} must yield ${expect}`);
    }
});

test('a read-only command is not accused of writing', () => {
    /*
     * The false-positive direction matters more than the false-negative one: claiming a read-only
     * command wrote a protected file is a wrong accusation, while missing a write is a gap.
     */
    const reads = [
        'cat file.txt',
        'bun run build 2>&1 | tail -20',
        'kubectl get pods -n mu',
        'git diff > /dev/null',
        'echo x 2>/dev/null',
        'rg -n "x > y" src',
        'echo "a > b"',
        'grep -o "a>>b" x',
        'rg -o "/assets/[^\"]+\\.js" /tmp/i.html | head -1',
    ];
    for (const cmd of reads) {
        assert.equal(shellHasWriteIntent(cmd), false, `${cmd} must not read as a write`);
    }
});

test('a quoted path is still a target, and a quoted operator is not', () => {
    // `>` inside quotes is text…
    assert.equal(shellHasWriteIntent('rg -n "x > y" src'), false);
    // …but a quoted target is a real path, so masking must not erase it.
    assert.equal(shellHasWriteIntent('cat > "my file.md"'), true);
    assert.deepEqual(shellWriteTargets('cat > "my file.md"'), ['my file.md']);
});

test('a heredoc body is data, and a python heredoc is code', () => {
    // A generated shell script containing `sed -i` is not an edit of the file being generated.
    const generate = "cat > out.sh << 'EOF'\nsed -i 's/a/b/' x\nEOF";
    assert.deepEqual(shellWriteTargets(generate), ['out.sh']);
    // A python heredoc IS the code, and its write calls live in the body.
    assert.equal(shellHasWriteIntent("python3 << 'PY'\nimport json\njson.dump(d, open(p, 'w'))\nPY"), true);
});

test('a python heredoc target is found in a string literal', () => {
    /*
     * The path is held in a variable, so no operator names it — and Cursor reports no `path` on the
     * Shell event for a heredoc. Measured on x79: three such commands wrote files (two protected) while
     * the event carried `path = null`, so the literal was the only place the target existed.
     */
    const cmd = [
        "python3 << 'PY'",
        'from pathlib import Path',
        'p = Path("/repo/sdlc/01.scenarios.md")',
        'text = p.read_text()',
        'p.write_text(text)',
        'PY',
    ].join('\n');
    assert.equal(shellHasWriteIntent(cmd), true);
    assert.deepEqual(shellWriteTargets(cmd), ['/repo/sdlc/01.scenarios.md']);
});

test('a read-only python script contributes no target', () => {
    // The literal extraction is gated on write intent, so reading a path cannot look like writing it.
    const cmd = "python3 -c 'print(open(\"/repo/src/a.ts\").read())'";
    assert.equal(shellHasWriteIntent(cmd), false);
    assert.deepEqual(shellWriteTargets(cmd), []);
});

test('the command is read out of the hook payload shape route-hook writes', () => {
    assert.equal(shellCommandOf(shellEvent('ls -la', '').raw_json), 'ls -la');
    assert.equal(shellCommandOf('{not json'), '');
    assert.equal(shellCommandOf(''), '');
});

// ---------------------------------------------------------------------------
// The pack hook contract
// ---------------------------------------------------------------------------

test('the pack exposes `shell-targets`, and nothing wires it to an IDE event', async () => {
    /*
     * The consumer's `guard-shell.py` runs this hook by name and parses its JSON, so the name and the
     * shape are a contract across a repo boundary — a rename would silently disable protected-path
     * writes with no error anywhere.
     *
     * It must also stay OUT of the profiles: every other hook emits a permission payload, and wiring
     * this one to an event would replace a real guard's decision with its JSON.
     */
    const { HOOKS } = await import('../packages/harness-host-generic/src/dispatch.mjs');
    assert.ok(HOOKS['shell-targets'], 'the hook must exist under this name');
    assert.equal(HOOKS['shell-targets'].kind, 'guard', 'a failure must not be reported as allow');

    const profiles = [
        'profiles/host/cursor-superset.json',
        'profiles/host/agents-superset.json',
    ];
    for (const rel of profiles) {
        const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
        assert.doesNotMatch(
            text,
            /shell-targets/,
            `${rel} must not wire shell-targets to an IDE event`,
        );
    }
});

// ---------------------------------------------------------------------------
// Ingest: a Shell write must land in request_file as an edit
// ---------------------------------------------------------------------------

test('a Shell write to a protected path is recorded as an edit, not a read', () => {
    /*
     * The finding: one turn wrote 7 protected files with `cat >` and `python3` heredocs, and every one
     * of them landed in `request_file` with `edits = 0`, because `actionOf('Shell')` is `'shell'` and
     * only `'edit'` increments. The harness therefore presented a turn that rewrote `sdlc/` as a turn
     * that only read it.
     */
    const { db, cfg } = fixture();
    try {
        const rel = 'sdlc/08.wbs/03.stories/03.us-b1-roles-rbac/qc/00.index.md';
        addEvent(db, { ...shellEvent(`cat > ${cfg.root}/${rel} << 'EOF'\nhi\nEOF`, rel) });

        overlayEvidence(db, cfg, null);

        const row = db.get('SELECT reads, edits, actions FROM request_file WHERE request_id = ? AND path = ?', [REQ, rel]);
        assert.ok(row, 'the written path must be recorded');
        assert.equal(row.edits, 1, 'a `cat >` is an edit');
        assert.match(row.actions, /edit/);
    } finally {
        db.close();
    }
});

test('a build or test command stays a read', () => {
    const { db, cfg } = fixture();
    try {
        const rel = 'backend/mu-fusion/package.json';
        addEvent(db, { ...shellEvent('cd /w && bun run build 2>&1 | tail -20', rel) });

        overlayEvidence(db, cfg, null);

        const row = db.get('SELECT reads, edits FROM request_file WHERE request_id = ? AND path = ?', [REQ, rel]);
        assert.equal(row?.edits ?? 0, 0, 'running a build must not count as editing the file');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Checks: the verdict must see Shell writes, and must not assert what it cannot know
// ---------------------------------------------------------------------------

test('the protected-write check fails on a Shell write, and says it came via Shell', () => {
    /*
     * Before this, the check read only `afterFileEdit` — an event the pack never wires — so it saw
     * nothing and reported "no protected path was edited" while the protected files were on disk.
     */
    const { db, cfg } = fixture();
    try {
        const rel = 'sdlc/08.wbs/03.stories/03.us-b1-roles-rbac/02.qc-execution.md';
        addEvent(db, { ...shellEvent(`cat > ${cfg.root}/${rel} << 'EOF'\nhi\nEOF`, rel) });
        overlayEvidence(db, cfg, null);

        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'brain-before-protected-write',
        ]);
        assert.equal(row.status, 'fail', 'a protected write with no brain call must fail');
        assert.match(row.detail, /via Shell/);
        assert.match(row.detail, /sdlc\//);
    } finally {
        db.close();
    }
});

test('the protected-write check reports uncertainty instead of asserting nothing was touched', () => {
    // A read-only turn: no edit signal exists at all. The old wording claimed "no protected path was
    // edited", which is a finding about the filesystem drawn from data that says nothing about it.
    const { db, cfg } = fixture();
    try {
        addEvent(db, { ...shellEvent('rg -n "todo" src', 'src/a.ts') });
        overlayEvidence(db, cfg, null);

        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, heuristic, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'brain-before-protected-write',
        ]);
        assert.equal(row.status, 'skip');
        assert.match(row.detail, /cannot determine/);
        assert.equal(row.heuristic, 1, 'a skipped check must not be presented as a clean result');
        assert.doesNotMatch(row.detail, /no protected path was edited/);
    } finally {
        db.close();
    }
});

test('verify-after-edit distinguishes "no edits" from "cannot see edits"', () => {
    const { db, cfg } = fixture();
    try {
        const rel = 'sdlc/notes.md';
        addEvent(db, { ...shellEvent(`cat > ${cfg.root}/${rel} << 'EOF'\nhi\nEOF`, rel) });
        overlayEvidence(db, cfg, null);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'verify-after-edit',
        ]);
        assert.match(row.detail, /cannot judge/, 'edits exist, so "no edits" would be false');
    } finally {
        db.close();
    }
});

test('verify-after-edit ignores edits outside the repository', () => {
    /*
     * A real turn (BAP-38) wrote `/tmp/analyze*.mjs` after `tsc` had passed and was reported as
     * "no verify after the final edit": scratch files outside the checkout extended the edit window,
     * although no repository build can ever verify them. `route-watch.mjs` already normalised paths
     * through `toRel`; `checks.mjs` did not.
     */
    const { db, cfg } = fixture();
    try {
        addEvent(db, { eventType: 'afterFileEdit', tool: 'Write', path: `${cfg.root}/src/feature.ts` });
        addEvent(db, shellEvent('./node_modules/.bin/tsc --noEmit 2>&1; echo tsc-exit=$?', 'src/feature.ts'));
        addEvent(db, { eventType: 'afterFileEdit', tool: 'Write', path: '/tmp/analyze-session.mjs' });
        overlayEvidence(db, cfg, null);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'verify-after-edit',
        ]);
        assert.equal(row.status, 'pass', `scratch write must not invalidate the verify: ${row.detail}`);
    } finally {
        db.close();
    }
});

test('verify-after-edit treats a scratch-only edit as no source edit', () => {
    const { db, cfg } = fixture();
    try {
        addEvent(db, { eventType: 'afterFileEdit', tool: 'Write', path: '/tmp/analyze-session.mjs' });
        overlayEvidence(db, cfg, null);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'verify-after-edit',
        ]);
        assert.equal(row.status, 'skip', 'a scratch file is not a repository edit');
        assert.match(row.detail, /no edits in this request/);
    } finally {
        db.close();
    }
});

test('verify-after-edit counts host-absolute paths when the consumer is mounted elsewhere', () => {
    /*
     * Inside Docker the consumer lives at /data/repo while hook payloads carry the host path
     * (/Users/.../baplatform). A `path.relative(cfg.root, …)` test classified every real edit as
     * "outside the repository" and turned the check off for the whole deployment.
     */
    const { db, cfg } = fixture();
    try {
        const hostPath = '/Users/someone/baplatform/src/feature.ts';
        addEvent(db, { eventType: 'afterFileEdit', tool: 'StrReplace', path: hostPath });
        addEvent(db, shellEvent('./node_modules/.bin/tsc --noEmit 2>&1; echo tsc-exit=$?', hostPath));
        overlayEvidence(db, cfg, null);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT status FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'verify-after-edit',
        ]);
        assert.equal(row.status, 'pass', 'a host-absolute source edit must still count as an edit');
    } finally {
        db.close();
    }
});

test('verify-after-edit ignores product state inside the repository', () => {
    const { db, cfg } = fixture();
    try {
        addEvent(db, { eventType: 'afterFileEdit', tool: 'StrReplace', path: `${cfg.root}/.cursor/session/.pipeline-brain-stamp.json` });
        overlayEvidence(db, cfg, null);
        computeChecks(db, cfg, null);

        const row = db.get('SELECT status, detail FROM check_result WHERE request_id = ? AND check_id = ?', [
            REQ,
            'verify-after-edit',
        ]);
        assert.equal(row.status, 'skip');
        assert.match(row.detail, /no edits in this request/);
    } finally {
        db.close();
    }
});
