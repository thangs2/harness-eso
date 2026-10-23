/**
 * P-26 — a law gap the index cannot answer must be visible as a fact, not as a silence.
 *
 * `fineso` (2026-10-23): the consumer's docgraph answered `docgraph:miss:harness-tooling` on every
 * preflight. The projection kept the gap and threw the trace away, so the agent saw only
 * `Gaps: law`, retried, failed, and reported the harness (the tool) as broken. The defect was in the
 * *index*, and nothing in the surface said so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPreflightProjection, extractLawMisses } from '@mu/harness-eso-core';

const turn = { userQueryStem: 'audit the last session', root: null, harnessTree: 'cursor' };

test('extractLawMisses reads the adapter trace, and ignores hits and unrelated lines', () => {
    const trace = [
        'docgraph:ok:decision-facade',
        'docgraph:miss:harness-tooling',
        'docgraph:skip-empty',
        'docgraph:ok:harness-eso:spec_debt',
        'docgraph:miss:mu-bible',
    ];
    assert.deepEqual(extractLawMisses({ retrieval: { trace } }), ['harness-tooling', 'mu-bible']);
    assert.deepEqual(extractLawMisses({ retrieval: { trace: [] } }), []);
    assert.deepEqual(extractLawMisses({}), []);
    assert.deepEqual(extractLawMisses({ retrieval: { trace: 'not-an-array' } }), []);
});

test('a projection with an unanswerable law term carries lawMisses for the hook to state', () => {
    const result = {
        verdict: {
            sufficiency: {
                level: 'insufficient',
                score: 0,
                gaps: [{ kind: 'law', query: 'harness-tooling' }],
            },
        },
        retrieval: { trace: ['docgraph:miss:harness-tooling'] },
    };
    const pre = buildPreflightProjection(turn, result, {});
    assert.deepEqual(pre.lawMisses, ['harness-tooling']);
    assert.equal(pre.level, 'insufficient');
});

test('a healthy projection reports no misses and keeps the field present', () => {
    const result = {
        verdict: { sufficiency: { level: 'sufficient', score: 1, gaps: [] } },
        retrieval: { trace: ['docgraph:ok:harness-tooling'] },
    };
    const pre = buildPreflightProjection(turn, result, {});
    assert.deepEqual(pre.lawMisses, [], 'the key must exist so a reader can tell "no miss" from "not measured"');
});
