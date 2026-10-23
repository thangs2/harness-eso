import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendBlockerRecord,
    blockerLogFile,
    createBlockerRecorder,
    readBlockerRecords,
} from '../packages/harness-eso-core/src/blocker-log.mjs';

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blocklog-'));
    return path.join(dir, 'eso-blockers.jsonl');
}

function withEnv(value, fn) {
    const previous = process.env.HARNESS_ESO_BLOCKER_LOG;
    process.env.HARNESS_ESO_BLOCKER_LOG = value;
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.HARNESS_ESO_BLOCKER_LOG;
        else process.env.HARNESS_ESO_BLOCKER_LOG = previous;
    }
}

test('the log lives in product state, overridable by the environment', () => {
    assert.match(blockerLogFile(), /\.harness[\\/]eso-blockers\.jsonl$/);
    withEnv('/tmp/custom-blockers.jsonl', () => {
        assert.equal(blockerLogFile(), '/tmp/custom-blockers.jsonl');
    });
});

test('a rejection record keeps the blocker names and drops fields nobody can act on', () => {
    const file = tempFile();
    const { record } = appendBlockerRecord({
        file,
        host: 'dsh',
        at: '2026-10-21T12:00:00Z',
        event: 'agent/pre-step',
        step: 3,
        agent: 'a1',
        stem: 'ship the project fix',
        blockers: [{ source: 'migration', kind: 'drop-table', ref: '001.sql', detail: 'the table disappears', statement: 'x' }],
        errors: [{ source: 'project', detail: 'cannot read q.sql', stack: 'ignored' }],
    });

    assert.equal(record.kind, 'rejected');
    assert.equal(record.step, 3);
    assert.deepEqual(record.blockers, [
        { source: 'migration', kind: 'drop-table', ref: '001.sql', detail: 'the table disappears' },
    ]);
    assert.deepEqual(record.errors, [{ source: 'project', detail: 'cannot read q.sql' }]);
    assert.equal(record.at, '2026-10-21T12:00:00Z');
});

test('the trail is append-only, and read back newest last', () => {
    const file = tempFile();
    appendBlockerRecord({ file, kind: 'first', blockers: [] });
    appendBlockerRecord({ file, kind: 'second', blockers: [] });

    const records = readBlockerRecords(file);
    assert.deepEqual(records.map((r) => r.kind), ['first', 'second']);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

    assert.deepEqual(readBlockerRecords(file, { limit: 1 }).map((r) => r.kind), ['second']);
});

test('a missing file reads as an empty trail, not an error', () => {
    assert.deepEqual(readBlockerRecords(path.join(os.tmpdir(), 'does-not-exist-blockers.jsonl')), []);
});

test('the recorder reports a write failure instead of throwing, so the reject still happens', () => {
    const notADir = tempFile();
    fs.writeFileSync(notADir, 'i am a file\n');
    const record = createBlockerRecorder({ file: path.join(notADir, 'nested', 'blockers.jsonl') });
    const result = record({ blockers: [{ source: 'project', kind: 'query-without-caller', ref: 'q.sql' }] });
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOTDIR|EEXIST|not a directory/i);
});

test('project id is read from the consumer config when not supplied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blocklog-root-'));
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ project: { id: 'x79' } }));
    const file = tempFile();
    const record = createBlockerRecorder({ root, file });
    const result = record({ blockers: [] });
    assert.equal(result.ok, true);
    assert.equal(result.record.projectId, 'x79');
});
