import test from 'node:test';
import assert from 'node:assert/strict';
import { decideParentStatus } from '../scripts/lib/jira-rollup.mjs';

const decide = decideParentStatus;

test('rollup: any child In Progress → parent In Progress', () => {
    assert.equal(decide('To Do', ['In Progress', 'To Do']), 'In Progress');
    assert.equal(decide('Human In Review', ['In Progress', 'Human In Review']), 'In Progress');
    assert.equal(decide('In Progress', ['In Progress']), null);
});

test('rollup: all children Human In Review/Done → parent Human In Review', () => {
    assert.equal(decide('In Progress', ['Human In Review', 'Human In Review']), 'Human In Review');
    assert.equal(decide('To Do', ['Human In Review']), 'Human In Review');
    assert.equal(decide('In Progress', ['Human In Review', 'Done']), 'Human In Review');
    assert.equal(decide('Human In Review', ['Human In Review', 'Done']), null);
});

test('rollup: mixed HIR/Done with To Do → parent In Progress, not review', () => {
    assert.equal(decide('Human In Review', ['Human In Review', 'To Do']), 'In Progress');
    assert.equal(decide('To Do', ['Human In Review', 'To Do']), 'In Progress');
    assert.equal(decide('In Progress', ['Human In Review', 'To Do']), null);
});

test('rollup: never sets Done and never reopens Done/Closed', () => {
    assert.equal(decide('In Progress', ['Done', 'Done']), 'Human In Review');
    assert.equal(decide('Done', ['In Progress']), null);
    assert.equal(decide('Closed', ['Human In Review']), null);
});

test('rollup: all To Do stays put; no children / unknown status is a no-op', () => {
    assert.equal(decide('To Do', ['To Do', 'To Do']), null);
    assert.equal(decide('In Progress', []), null);
    assert.equal(decide('In Progress', ['Some Future Status']), null);
});
