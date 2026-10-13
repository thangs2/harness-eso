import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSystemOne } from '@mu/harness-system-one';
import { decide } from '@mu/harness-decision';

test('postSystemOne skips HTTP when jev.mode off', async () => {
    let calls = 0;
    const mockFetch = async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => '{}' };
    };
    const r = await postSystemOne(
        { state: 'x', questions: {} },
        { policy: { jev: { mode: 'off' } }, fetchImpl: mockFetch },
    );
    assert.equal(r.skipped, true);
    assert.equal(calls, 0);
});

test('decide shadow calls Jev on ambiguous route but keeps L0 tie winner label', async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
        fetchCalls += 1;
        return {
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    answers: { route_bucket: { probabilities: { backend: 0.95, frontend: 0.05 } } },
                }),
        };
    };
    const policy = {
        jev: { mode: 'shadow', model: 'jev-latest' },
        on_ambiguous: 'hil_only',
        thresholds: { choice_auto: 0.9, choice_confirm: 0.5, l0_score_gap: 5 },
        budget: { maxS1PaidCallsPerTurn: 1 },
        privacy: { maxStateChars: 4000, denyPathPatterns: [] },
    };
    const out = await decide(
        {
            event: 'turn_start',
            turnId: 'jev-1',
            userQueryStem: 'ambiguous routing',
            hookMeta: { forceAmbiguous: true },
        },
        { policy, apiKey: 'test-key', fetchImpl: mockFetch, jevCallsThisTurn: 0 },
    );
    assert.equal(out.kind, 'ambiguous');
    assert.equal(out.jev?.called, true);
    assert.equal(out.jev?.shadowOnly, true);
    assert.equal(fetchCalls, 1);
});

test('decide active enforces Jev route tie-break', async () => {
    const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () =>
            JSON.stringify({
                answers: { route_bucket: { probabilities: { backend: 0.95, frontend: 0.05 } } },
            }),
    });
    const policy = {
        jev: { mode: 'active' },
        thresholds: { choice_auto: 0.9, choice_confirm: 0.5 },
        budget: { maxS1PaidCallsPerTurn: 1 },
        privacy: { maxStateChars: 4000, denyPathPatterns: [] },
    };
    const out = await decide(
        {
            event: 'turn_start',
            turnId: 'jev-2',
            hookMeta: { forceAmbiguous: true },
        },
        { policy, apiKey: 'test-key', fetchImpl: mockFetch },
    );
    assert.equal(out.kind, 'route');
    assert.equal(out.resolverWinner, 'route_jev');
    assert.equal(out.route?.bucket, 'backend');
    assert.equal(out.route?.jevEnforced, true);
});
