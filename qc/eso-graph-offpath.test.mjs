import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTurnSafe, dispatchQuery } from '../eso/graph/src/index.mjs';

test('SCN-ARCH-03 (AC-ARCH-01-03 & INV-GR-01): Heavy extraction queries are dispatched off-path, never blocking turn', async () => {
    // 1. Light queries are turn safe
    assert.equal(isTurnSafe('Q1: read files list'), true);
    assert.equal(isTurnSafe('get completeness for Q2'), true);

    // 2. Heavy extraction / AST scans are not turn safe
    assert.equal(isTurnSafe('run extract on project'), false);
    assert.equal(isTurnSafe('ast_extract all modules'), false);
    assert.equal(isTurnSafe({ heavy: true }), false);
    assert.equal(isTurnSafe({ type: 'extract' }), false);

    // 3. Dispatching heavy query queues it off-path without executing inline
    let inlineExecuted = false;
    const offPathQueue = [];

    const dispatchResult = await dispatchQuery(
        'ast_extract full repository',
        async () => {
            inlineExecuted = true;
        },
        { offPathQueue }
    );

    assert.equal(inlineExecuted, false, 'Heavy extractor MUST NOT run inline on the turn path (INV-GR-01)');
    assert.equal(dispatchResult.mode, 'off-path');
    assert.equal(dispatchResult.completed, false);
    assert.equal(dispatchResult.queued, true);
    assert.equal(offPathQueue.length, 1);
    assert.equal(offPathQueue[0].status, 'queued');
});
