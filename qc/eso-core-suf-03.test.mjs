import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    emitProactiveWarning,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-12 (AC-SUF-03-01): Proactive warning emitted unprompted when task is about to run with level < sufficient', () => {
    const verdict = {
        level: 'partial',
        mode: 'do',
        gaps: [
            { what: 'unindexed-entity', where_hint: 'src/models.ts', source: 'bar', exists: 'absent' },
            { what: 'unverified-contract', where_hint: 'specs/api.yaml', source: 'blast', exists: 'unknown' },
        ],
    };

    const result = emitProactiveWarning({
        verdict,
        task_id: 'task-pre-dispatch',
        project: 'proj-suf-12',
    });

    assert.equal(result.warned, true);
    assert.equal(result.level, 'partial');
    assert.equal(result.warnings.length, 2);
    assert.equal(result.warnings[0].requirement, 'unindexed-entity');
    assert.equal(result.warnings[0].where_hint, 'src/models.ts');
    assert.equal(result.warnings[1].requirement, 'unverified-contract');
    assert(result.message.includes('CẢNH BÁO TỰ PHÁT'));
});

test('SCN-SUF-13 (AC-SUF-03-02): Already warned (task, requirement) is not re-emitted on subsequent run (count = 1)', () => {
    const verdict = {
        level: 'insufficient',
        mode: 'ask',
        gaps: [{ what: 'schema-gap', where_hint: 'schema.sql', source: 'work', exists: 'absent' }],
    };
    const historyState = new Set();

    const firstRun = emitProactiveWarning({
        verdict,
        task_id: 'task-once',
        project: 'proj-suf-13',
        historyState,
    });
    assert.equal(firstRun.warned, true);
    assert.equal(firstRun.warnings.length, 1);

    const secondRun = emitProactiveWarning({
        verdict,
        task_id: 'task-once',
        project: 'proj-suf-13',
        historyState,
    });
    assert.equal(secondRun.warned, false);
    assert.equal(secondRun.deduplicated, true);
    assert.equal(secondRun.warnings.length, 0);
});

test('SCN-SUF-14 (AC-SUF-03-03 / BR-07): Warning is non-blocking, task continues and mode is preserved', () => {
    const verdict = {
        level: 'partial',
        mode: 'do',
        gaps: [{ what: 'minor-gap', where_hint: 'hint', source: 'declared', exists: 'absent' }],
    };

    const result = emitProactiveWarning({
        verdict,
        task_id: 'task-noblock',
    });

    assert.equal(result.warned, true);
    assert.equal(result.blocked, false);
    assert.equal(result.mode, 'do');
    assert.notEqual(result.mode, 'block');
});

test('SCN-SUF-30 (AC-SUF-03-04 & ED6): Duplicate arrival in same turn yields exactly 1 warning', () => {
    const verdict = {
        level: 'insufficient',
        mode: 'ask',
        gaps: [
            { what: 'dup-gap', where_hint: 'h1', source: 'work', exists: 'absent' },
            { what: 'dup-gap', where_hint: 'h1', source: 'work', exists: 'absent' }, // duplicated in same turn
        ],
    };
    const historyState = new Set();

    const result = emitProactiveWarning({
        verdict,
        task_id: 'task-dup-turn',
        historyState,
    });

    assert.equal(result.warned, true);
    assert.equal(result.warnings.length, 1, 'Duplicate item in same turn must be deduplicated to 1');
});

test('SCN-SUF-31 (AC-SUF-03-05 & ED1): 0 requirements below sufficient yields 0 warnings, no empty warning created', () => {
    const verdict = {
        level: 'sufficient',
        mode: 'do',
        gaps: [],
    };

    const result = emitProactiveWarning({
        verdict,
        task_id: 'task-all-sufficient',
    });

    assert.equal(result.warned, false);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.message, null);
});

test('SCN-SUF-41 (AC-SUF-03-06): False-positive = 0: level === sufficient emits no warning even when called', () => {
    const verdict = {
        level: 'sufficient',
        mode: 'do',
        gaps: [],
    };

    const result = emitProactiveWarning({
        verdict,
        task_id: 'task-fp-zero',
    });

    assert.equal(result.warned, false);
    assert.equal(result.warnings.length, 0);
});
