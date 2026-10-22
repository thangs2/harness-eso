import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrate, openDb, upsertProject } from '../packages/harness-observe-server/src/observe-db.mjs';
import { ingestGateTrail } from '../packages/harness-observe-server/src/ingest-gate.mjs';
import { discoverDshSessions, ingestDshSession, ingestDshSessions } from '../packages/harness-observe-server/src/ingest-dsh.mjs';

function freshDb() {
    const db = openDb(':memory:');
    migrate(db);
    upsertProject(db, {
        project: { id: 'p1', displayName: 'p1' },
        root: '/work/p1',
        configPath: '/work/p1/harness.config.json',
        storage: { driver: 'sqlite', target: ':memory:' },
    });
    return db;
}

test('gate trail: only this project is ingested, and re-reading inserts nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const trail = path.join(dir, 'eso-blockers.jsonl');
    const record = (projectId, ref) =>
        JSON.stringify({
            at: '2026-10-22T05:00:00Z',
            kind: 'tool-deny',
            host: 'dsh',
            event: 'tools/pre-execute',
            tool: 'write',
            projectId,
            blockers: [{ source: 'policy', kind: 'gate-decision', ref, detail: `${ref} is locked` }],
        });
    fs.writeFileSync(trail, [record('p1', 'secrets/a.txt'), record('other', 'x.txt'), record('p1', 'secrets/b.txt')].join('\n'));

    const db = freshDb();
    const first = ingestGateTrail(db, { project: { id: 'p1' }, gateTrailPath: trail });
    assert.equal(first.ok, true);
    assert.equal(first.lines, 3);
    assert.equal(first.skipped, 1, 'a record for another project is not guessed into this db');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM gate_event').n, 2);

    const second = ingestGateTrail(db, { project: { id: 'p1' }, gateTrailPath: trail });
    assert.equal(second.inserted, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM gate_event').n, 2);

    const row = db.get('SELECT kind, tool, ref, detail FROM gate_event WHERE ref = ?', ['secrets/a.txt']);
    assert.equal(row.kind, 'tool-deny');
    assert.equal(row.tool, 'write');
    assert.match(row.detail, /is locked/);
});

test('gate trail: a missing file is not an error, a broken line is skipped', () => {
    const db = freshDb();
    const absent = ingestGateTrail(db, { project: { id: 'p1' }, gateTrailPath: '/nope/eso-blockers.jsonl' });
    assert.equal(absent.ok, true);
    assert.equal(absent.absent, true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bad-'));
    const trail = path.join(dir, 'eso-blockers.jsonl');
    fs.writeFileSync(trail, '{not json\n');
    const report = ingestGateTrail(db, { project: { id: 'p1' }, gateTrailPath: trail });
    assert.equal(report.ok, true);
    assert.equal(report.skipped, 1);
});

function sessionFile(root, events) {
    const dir = path.join(root, '--work-p1--', 'session-abc');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl');
    fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    return file;
}

test('a DSH session becomes a conversation, a request per turn, calls per step and tool events', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-'));
    sessionFile(root, [
        { type: 'session', seq: 0, time: 1000, data: { id: 'session-abc', cwd: '/work/p1' } },
        { type: 'request/header', seq: 1, time: 1001, data: { header: { config: { model: 'deepseek-flash' } } } },
        { type: 'turn/start', seq: 2, time: 1002, data: { turn: 1 } },
        { type: 'step/start', seq: 3, time: 1003, data: { turn: 1, step: 1 } },
        { type: 'user/message', seq: 4, time: 1004, data: { content: [{ type: 'text', text: 'ship the tenant fix' }] } },
        { type: 'assistant/message', seq: 5, time: 1005, data: { message: { content: [{ type: 'text', text: 'on it' }] } } },
        { type: 'tool/call', seq: 6, time: 1006, data: { name: 'write', arguments: { path: 'secrets/a.txt' } } },
        { type: 'tool/result', seq: 7, time: 1007, data: { name: 'write' } },
        { type: 'step/end', seq: 8, time: 1008, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 9, time: 1009, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);

    const found = discoverDshSessions([root]);
    assert.equal(found.length, 1);

    const db = freshDb();
    const report = ingestDshSession(db, { project: { id: 'p1' } }, found[0]);
    assert.equal(report.ok, true);
    assert.equal(report.turns, 1);
    assert.equal(report.calls, 1);

    const conversation = db.get('SELECT id, request_count FROM conversation');
    assert.equal(conversation.id, 'session-abc');
    assert.equal(conversation.request_count, 1);

    const request = db.get('SELECT id, user_query, status, call_count, tool_count, model_id FROM request');
    assert.equal(request.id, 'session-abc:1');
    assert.equal(request.user_query, 'ship the tenant fix');
    assert.equal(request.status, 'completed');
    assert.equal(request.call_count, 1);
    assert.equal(request.tool_count, 1);
    assert.equal(request.model_id, 'deepseek-flash');

    const call = db.get('SELECT call_index, tool_names, preview FROM llm_call');
    assert.equal(call.call_index, 1);
    assert.equal(call.tool_names, 'write');
    assert.match(call.preview, /on it/);

    const events = db.all('SELECT event_type, tool FROM event ORDER BY id');
    assert.deepEqual(events.map((e) => e.event_type), ['tool/call', 'tool/result', 'turn/end']);
    assert.equal(events[0].tool, 'write');

    // Re-ingest must not duplicate: ids are derived.
    ingestDshSession(db, { project: { id: 'p1' } }, found[0]);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM request').n, 1);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM event').n, 3);
});

test('an errored turn is stored as error, and an empty dir produces no reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-err-'));
    sessionFile(root, [
        { type: 'session', seq: 0, time: 2000, data: { id: 'session-err' } },
        { type: 'turn/start', seq: 1, time: 2001, data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: 2002, data: { turn: 1, reason: { kind: 'error' } } },
    ]);
    const db = freshDb();
    const reports = ingestDshSessions(db, { project: { id: 'p1' } }, [root]);
    assert.equal(reports.length, 1);
    assert.equal(db.get('SELECT status FROM request').status, 'error');

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-'));
    assert.deepEqual(ingestDshSessions(db, { project: { id: 'p1' } }, [empty]), []);
});

test('discovery is scoped to one workspace, because ~/.dsh holds every workspace on the machine', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slugs-'));
    for (const slug of ['--work-p1--', '--work-other--']) {
        const dir = path.join(root, slug, 'session-x');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{"type":"session","seq":0,"data":{"id":"session-x"}}\n');
    }
    assert.equal(discoverDshSessions([root]).length, 2);
    const scoped = discoverDshSessions([root], { projectSlug: '--work-p1--' });
    assert.equal(scoped.length, 1);
    assert.match(scoped[0].file, /--work-p1--/);
});
