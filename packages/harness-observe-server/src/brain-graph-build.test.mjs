import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDb } from '@mu/harness-foundation';
import { createApiHelpers } from './observe-api.mjs';
import { migrate } from './observe-db.mjs';
import { BRAIN_LAYER_OF_KIND, areaOfPath, buildBrainGraph } from './brain-graph-build.mjs';

/** A fresh, migrated database on disk (openDb owns the file, so :memory: is not an option). */
function freshDb(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-graph-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, 'observe.db'));
    migrate(db);
    t.after(() => db.close());
    return db;
}

function seedProject(db, root) {
    db.run(
        `INSERT INTO project (id, display_name, root_path, config_path, storage_driver, storage_target, created_at, updated_at)
         VALUES ('p', 'harness-eso', ?, '/tmp/harness.config.json', 'sqlite', '/tmp/observe.db', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
        [root],
    );
}

function seedRun(db, { id, conversation, boundary, query, startedAt, callCount = 2 }) {
    db.run(
        `INSERT OR IGNORE INTO conversation (id, project_id, created_at, updated_at) VALUES (?, 'p', ?, ?)`,
        [conversation, startedAt, startedAt],
    );
    db.run(
        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, started_at, ended_at,
             status, call_count, created_at, updated_at)
         VALUES (?, 'p', ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
        [id, conversation, boundary, query, startedAt, startedAt, callCount, startedAt, startedAt],
    );
    db.run(
        `INSERT INTO request_file (request_id, path, actions, reads, edits) VALUES (?, ?, 'edit', 1, 1)`,
        [id, `${query}`],
    );
}

test('areaOfPath strips the project root and falls back to the first segment', () => {
    assert.equal(areaOfPath('/work/proj/packages/x/y.mjs', '/work/proj'), 'packages');
    assert.equal(areaOfPath('/work/other/docs/a.md', '/work/proj'), 'work');
    assert.equal(areaOfPath('/work/proj/README.md', '/work/proj'), '(root files)');
    assert.equal(areaOfPath('C:\\work\\proj\\docs\\a.md', 'C:/work/proj'), 'docs');
});

test('builds root, areas, notes, skills, tools, runs and harness apps from the observe DB', (t) => {
    const db = freshDb(t);
    const root = '/work/proj';
    seedProject(db, root);

    seedRun(db, {
        id: 'c1:1',
        conversation: 'c1',
        boundary: 1,
        query: `${root}/packages/harness-observatory/src/App.tsx`,
        startedAt: '2026-10-01T10:00:00Z',
    });
    seedRun(db, {
        id: 'c1:2',
        conversation: 'c1',
        boundary: 2,
        query: `${root}/documents/00.README.md`,
        startedAt: '2026-10-01T11:00:00Z',
    });
    // A second run touching the same file must not create a second note.
    db.run(
        `INSERT INTO request_file (request_id, path, actions, reads, edits) VALUES ('c1:2', ?, 'read', 1, 0)`,
        [`${root}/packages/harness-observatory/src/App.tsx`],
    );
    db.run(`INSERT INTO request_rule (request_id, rule_id, attached_at) VALUES ('c1:1', 'core.harness-product', '2026-10-01T10:00:00Z')`);
    db.run(`INSERT INTO request_tool (request_id, tool, count) VALUES ('c1:1', 'read', 3)`);
    db.run(
        `INSERT INTO event (project_id, harness, event_type, tool, path, request_id, hook_at, source_path, source_line_no, raw_json)
         VALUES ('p', 'cursor', 'PreToolUse', 'read', '/x', 'c1:1', '2026-10-01T10:00:00Z', '/hooks/log.jsonl', 1, '{}')`,
    );

    const graph = buildBrainGraph({ db, cfg: { project: { id: 'p' }, root }, builtAt: '2026-10-22T00:00:00Z' });
    const byKind = (kind) => graph.nodes.filter((n) => n.kind === kind);

    assert.equal(byKind('root').length, 1);
    assert.equal(byKind('root')[0].id, 'project:p');
    assert.equal(byKind('area').length, 2, 'packages + documents');
    assert.equal(byKind('note').length, 2);
    assert.equal(byKind('skill').length, 1);
    assert.equal(byKind('tool').length, 1);
    assert.equal(byKind('run').length, 2);
    assert.equal(byKind('app').length, 1);
    assert.equal(byKind('app')[0].id, 'app:cursor');

    for (const node of graph.nodes) {
        assert.equal(node.layer, BRAIN_LAYER_OF_KIND[node.kind], `${node.id} layer`);
        if (node.kind !== 'root') assert.ok(node.degree > 0, `${node.id} has no links`);
    }

    // Every link endpoint exists — a dangling link would crash the renderer.
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const l of graph.links) {
        assert.ok(ids.has(l.s), `missing source ${l.s}`);
        assert.ok(ids.has(l.t), `missing target ${l.t}`);
    }
    assert.equal(new Set(graph.links.map((l) => `${l.s}>${l.t}`)).size, graph.links.length, 'links are unique');

    assert.deepEqual(graph.meta.sources.map((s) => s.source), [
        'project',
        'request',
        'request_file',
        'request_rule',
        'request_tool',
        'event.harness',
    ]);
    assert.equal(graph.meta.omitted[0].layer, 'routines');
    assert.match(graph.legend, /nodes/);

    // Timeline lanes are only meaningful if every layer can carry a timestamp; each one below is a
    // MAX over rows that already exist, never a fabricated "now".
    const area = byKind('area').find((n) => n.label === 'packages');
    assert.equal(area.changed, '2026-10-01T11:00:00Z', 'newest file in the area');
    assert.equal(byKind('skill')[0].changed, '2026-10-01T10:00:00Z');
    assert.equal(byKind('tool')[0].changed, '2026-10-01T10:00:00Z', 'borrowed from the run that called it');
    assert.equal(byKind('app')[0].changed, '2026-10-01T10:00:00Z');
    // /work/proj does not exist on this machine, so nothing is previewable — the card must say so
    // instead of offering a button the route can only answer with 404.
    assert.equal(byKind('note').every((n) => n.previewable === false), true);
});

test('caps are reported with shown and total, never silently dropped', (t) => {
    const db = freshDb(t);
    const root = '/work/proj';
    seedProject(db, root);
    for (let i = 1; i <= 5; i += 1) {
        seedRun(db, {
            id: `c:i${i}`,
            conversation: 'c',
            boundary: i,
            query: `${root}/docs/f${i}.md`,
            startedAt: `2026-10-0${i}T10:00:00Z`,
        });
    }

    const graph = buildBrainGraph({
        db,
        cfg: { project: { id: 'p' }, root },
        limits: { runs: 2, notes: 2 },
        builtAt: '2026-10-22T00:00:00Z',
    });
    assert.equal(graph.nodes.filter((n) => n.kind === 'run').length, 2);
    assert.equal(graph.nodes.filter((n) => n.kind === 'note').length, 2);
    const runCap = graph.meta.truncated.find((x) => x.kind === 'run');
    assert.deepEqual([runCap.shown, runCap.total], [2, 5]);
    const noteCap = graph.meta.truncated.find((x) => x.kind === 'note');
    assert.deepEqual([noteCap.shown, noteCap.total], [2, 5]);
});

test('a host path is mapped to the container mount, and the host path is kept for display', (t) => {
    const db = freshDb(t);
    const hostRoot = '/host/workspaces/proj';
    seedProject(db, hostRoot);
    seedRun(db, {
        id: 'c:1',
        conversation: 'c',
        boundary: 1,
        query: `${hostRoot}/notes/a.md`,
        startedAt: '2026-10-01T10:00:00Z',
    });

    const previous = process.env.HARNESS_REPO_ROOT_HOST;
    process.env.HARNESS_REPO_ROOT_HOST = hostRoot;
    t.after(() => {
        if (previous === undefined) delete process.env.HARNESS_REPO_ROOT_HOST;
        else process.env.HARNESS_REPO_ROOT_HOST = previous;
    });

    const graph = buildBrainGraph({ db, cfg: { project: { id: 'p' }, root: hostRoot }, builtAt: '2026-10-22T00:00:00Z' });
    const note = graph.nodes.find((n) => n.kind === 'note');
    assert.equal(note.path, '/data/repo/notes/a.md', 'path must be openable by the server');
    assert.equal(note.pathHost, `${hostRoot}/notes/a.md`, 'pathHost keeps what the operator recognises');
});

test('the file route takes a node id and refuses anything that is not a file node', (t) => {
    const db = freshDb(t);
    const root = path.dirname(db.filePath);
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes/a.md'), '# hi\n');
    seedProject(db, root);
    seedRun(db, {
        id: 'c:1',
        conversation: 'c',
        boundary: 1,
        query: path.join(root, 'notes/a.md'),
        startedAt: '2026-10-01T10:00:00Z',
    });
    // A path that exists but lives outside the project root must not look previewable: the route
    // refuses it with outside_root, so the card must not offer the button.
    const stray = path.join(os.tmpdir(), `stray-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(stray, 'outside\n');
    t.after(() => fs.rmSync(stray, { force: true }));
    db.run(
        `INSERT INTO request_file (request_id, path, actions, reads, edits) VALUES ('c:1', ?, 'read', 1, 0)`,
        [stray],
    );

    const api = createApiHelpers(
        { project: { id: 'p' }, root, storage: { target: db.filePath } },
        { startedAt: '2026-10-22T00:00:00Z', actualPort: () => 8792 },
    );
    const graph = api.getBrainGraph();
    const noteId = graph.nodes.find((n) => n.kind === 'note').id;
    const areaId = graph.nodes.find((n) => n.kind === 'area').id;

    assert.equal(graph.nodes.find((n) => n.id === noteId).previewable, true, 'a real file is previewable');
    const strayNode = graph.nodes.find((n) => n.kind === 'note' && n.path === stray);
    assert.equal(strayNode.previewable, false, 'exists but outside the root → not previewable');
    const ok = api.getBrainFile(noteId);
    assert.equal(ok.ok, true);
    assert.equal(ok.text, '# hi\n');
    assert.equal(ok.nodeId, noteId);
    assert.equal(ok.pathHost, path.join(root, 'notes/a.md'));

    const area = api.getBrainFile(areaId);
    assert.deepEqual([area.ok, area.code, area.status], [false, 'not_allowed', 403]);
    const missing = api.getBrainFile('note:/nope.md');
    assert.deepEqual([missing.ok, missing.code, missing.status], [false, 'not_allowed', 403]);
    const empty = api.getBrainFile(null);
    assert.deepEqual([empty.ok, empty.code], [false, 'not_allowed']);
});

test('the API helper serves the graph and rebuilds only when the database file changes', (t) => {
    const db = freshDb(t);
    const root = '/work/proj';
    seedProject(db, root);
    seedRun(db, {
        id: 'c:1',
        conversation: 'c',
        boundary: 1,
        query: `${root}/docs/a.md`,
        startedAt: '2026-10-01T10:00:00Z',
    });

    const api = createApiHelpers(
        { project: { id: 'p' }, root, storage: { target: db.filePath } },
        { startedAt: '2026-10-22T00:00:00Z', actualPort: () => 8792 },
    );
    const first = api.getBrainGraph();
    assert.equal(first.nodes.filter((n) => n.kind === 'note').length, 1);

    // Same file, no write: the memo answers and returns the identical object.
    assert.equal(api.getBrainGraph(), first);

    // A new row changes the file, so the derived graph is rebuilt (E2: no stale cache).
    seedRun(db, {
        id: 'c:2',
        conversation: 'c',
        boundary: 2,
        query: `${root}/docs/b.md`,
        startedAt: '2026-10-01T11:00:00Z',
    });
    const second = api.getBrainGraph();
    assert.notEqual(second, first);
    assert.equal(second.nodes.filter((n) => n.kind === 'note').length, 2);
});

test('an uninitialised project yields an explained empty graph, not a fake one', (t) => {
    const db = freshDb(t);
    const graph = buildBrainGraph({ db, cfg: { project: { id: 'nope' }, root: '/work/proj' }, builtAt: '2026-10-22T00:00:00Z' });
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.links, []);
    assert.equal(graph.meta.sources[0].present, false);
    assert.equal(graph.meta.omitted[0].layer, 'all');
});
