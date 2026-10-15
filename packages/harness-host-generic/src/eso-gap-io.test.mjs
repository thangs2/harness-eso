import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    closesGap,
    gapId,
    gapKindsForTool,
    recordGapToolUse,
} from './eso-gap-io.mjs';

test('gapKindsForTool classifies correctly', () => {
    const readKinds = gapKindsForTool('Read', { path: 'foo.mjs' });
    assert.ok(readKinds.has('code'));
    assert.ok(readKinds.has('law'));
    assert.ok(readKinds.has('check'));

    const shellKinds = gapKindsForTool('Shell', { command: 'ls' });
    assert.ok(shellKinds.has('code'));

    const codegraphKinds = gapKindsForTool('CallDynamicTool', { name: 'codegraph_explore', query: 'detectGaps' });
    assert.ok(codegraphKinds.has('code'));
    assert.ok(codegraphKinds.has('symbol'));

    const docgraphKinds = gapKindsForTool('docgraph', { query: 'rules' });
    assert.ok(docgraphKinds.has('law'));
    assert.ok(docgraphKinds.has('doc'));

    const grepKinds = gapKindsForTool('Grep', { pattern: 'test' });
    assert.ok(grepKinds.has('code'));
    assert.ok(grepKinds.has('law'));
    assert.ok(grepKinds.has('doc'));
});

test('closesGap closes code read-count gap when tool input has a non-empty path', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const kinds = gapKindsForTool('Read', { path: 'packages/harness-eso-core/src/collect.mjs' });

    const closed = closesGap(gap, kinds, { path: 'packages/harness-eso-core/src/collect.mjs' }, 'Read');
    assert.equal(closed, true);
});

test('closesGap closes code read-count gap when tool is a codegraph call with non-empty query', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const toolInput = { name: 'codegraph_explore', query: 'detectGaps' };
    const kinds = gapKindsForTool('CallDynamicTool', toolInput);

    const closed = closesGap(gap, kinds, toolInput, 'CallDynamicTool');
    assert.equal(closed, true);

    const closedDirect = closesGap(gap, kinds, { query: 'detectGaps' }, 'codegraph_explore');
    assert.equal(closedDirect, true);
});

test('closesGap keeps code read-count gap open for Shell without file path', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const toolInput = { command: 'ls' };
    const kinds = gapKindsForTool('Shell', toolInput);

    const closed = closesGap(gap, kinds, toolInput, 'Shell');
    assert.equal(closed, false);
});

test('closesGap keeps code read-count gap open for Read with empty path', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const toolInput = { path: '' };
    const kinds = gapKindsForTool('Read', toolInput);

    const closed = closesGap(gap, kinds, toolInput, 'Read');
    assert.equal(closed, false);
});

test('closesGap keeps law gap open when tool path does not match query', () => {
    const gap = { kind: 'law', query: 'harness-tooling' };
    const toolInput = { path: 'packages/harness-eso-core/src/collect.mjs' };
    const kinds = gapKindsForTool('Read', toolInput);

    const closed = closesGap(gap, kinds, toolInput, 'Read');
    assert.equal(closed, false);
});

test('recordGapToolUse integration with fixture .eso-preflight.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-gap-test-'));
    const sessionDir = path.join(tmp, '.cursor', 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    const preflight = {
        at: '2026-10-15T12:00:00.000Z',
        gaps: [
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
            { kind: 'law', query: 'harness-tooling' },
        ],
    };
    fs.writeFileSync(path.join(sessionDir, '.eso-preflight.json'), JSON.stringify(preflight, null, 2));

    // 1. Shell 'ls' -> code gap stays open, law gap stays open
    let res = recordGapToolUse('Shell', { command: 'ls' }, { root: tmp, tree: 'cursor' });
    assert.ok(res);
    assert.equal(res.closedGapIds.length, 0);

    // 2. Read with path -> closes code gap, law gap stays open
    res = recordGapToolUse('Read', { path: 'packages/harness-eso-core/src/collect.mjs' }, { root: tmp, tree: 'cursor' });
    assert.ok(res);
    assert.deepEqual(res.closedGapIds, ['code:need at least 1 file read(s); have 0']);

    // 3. Read with law term -> closes law gap
    res = recordGapToolUse('Read', { path: 'rules/harness-tooling.md' }, { root: tmp, tree: 'cursor' });
    assert.ok(res);
    assert.ok(res.closedGapIds.includes('code:need at least 1 file read(s); have 0'));
    assert.ok(res.closedGapIds.includes('law:harness-tooling'));

    fs.rmSync(tmp, { recursive: true, force: true });
});
