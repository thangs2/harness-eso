import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichRequestListRow } from './request-list-enrich.mjs';

test('enrichRequestListRow uses stop tokens then emit estimate', () => {
    const row = enrichRequestListRow({
        id: 'c:1',
        conversationId: 'c',
        boundaryIndex: 1,
        userQuery: 'q',
        status: 'completed',
        emitCharsSum: 400,
        stopInputTokens: 1000,
        stopOutputTokens: null,
        inputTokens: null,
        outputTokens: null,
    });
    assert.equal(row.inputTokens, 1000);
    assert.equal(row.outputTokens, 100);
    assert.equal(row.tokensEstimated, true);
});

test('enrichRequestListRow keeps request columns', () => {
    const row = enrichRequestListRow({
        id: 'c:1',
        conversationId: 'c',
        boundaryIndex: 1,
        userQuery: 'q',
        status: 'completed',
        emitCharsSum: 0,
        inputTokens: 5,
        outputTokens: 9,
    });
    assert.equal(row.inputTokens, 5);
    assert.equal(row.outputTokens, 9);
    assert.equal(row.tokensEstimated, false);
});
