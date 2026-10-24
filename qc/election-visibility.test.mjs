import test from 'node:test';
import assert from 'node:assert/strict';

import { createSourceRegistry } from '@mu/harness-eso-core';
import { orchestrateTurn } from '@mu/harness-eso-core';
import { buildPreflightProjection } from '@mu/harness-eso-core';

/**
 * "The consumer elected native" must be a fact the product can state afterwards.
 *
 * The registry has always computed *how* a provider was chosen (`native` · `id:…` · `none` ·
 * `exhausted`); `resolve()` threw it away, `runCollect` recorded only the adapter's own trace line
 * (`docgraph:ok:<term>`), and nothing reached storage. So two turns — one where the host answered
 * because the policy asked for `native`, one where eso looked and found nothing — were
 * indistinguishable to an operator. The first is a configuration decision working; the second is a
 * gate that will keep failing. Telling them apart is the whole point.
 *
 * These tests fail if the election stops reaching the projection, which is the only thing that makes
 * the distinction real rather than documented.
 */

const NATIVE_MEMORY = {
    id: 'native:dsh-session',
    kinds: ['memory'],
    capability: 'native',
    ceiling: 0.65,
    async fetch() {
        return { snippets: [{ kind: 'memory', text: 'we shipped the gate yesterday' }], trace: 'native:dsh-session:ok' };
    },
};

const POLICIES = (sources) => ({
    jev: { mode: 'off' },
    eso: {
        enabled: true,
        mode: 'hint',
        enforceWrites: 'fail_closed',
        thresholds: { T_low: 0.45, T_high: 0.72 },
        cognition: { insufficientPromptGate: 'consent' },
        sources,
    },
});

test('elections(): reports reason AND provider id per kind', () => {
    const registry = createSourceRegistry(
        POLICIES({ memory: { prefer: ['native', 'none'] }, law: { enabled: false } }),
        [NATIVE_MEMORY],
    );
    const elections = registry.elections();
    assert.equal(elections.memory.reason, 'native', 'the chain asked for a native provider and one exists');
    assert.equal(elections.memory.providerId, 'native:dsh-session', 'the id names which one');
    assert.equal(elections.law.reason, 'disabled', 'a disabled kind says so instead of vanishing');
    assert.equal(elections.law.providerId, null);
    // `code` was NOT declared in this fixture, so the registry falls back to the first capable
    // builtin. That is existing, deliberate behaviour — the election reports it as `id:<adapter>`
    // rather than hiding it, which is the property under test.
    assert.equal(typeof elections.code.reason, 'string');
    // An undeclared kind takes the registry's `default` path — the first capable builtin. Reported as
    // `default`, not hidden, which is the property under test.
    assert.equal(elections.code.reason, 'default');
    assert.equal(elections.code.providerId, 'codegraph-cli');
});

test('elections(): an unelected chain is distinguishable from elected native', () => {
    /*
     * Three outcomes the operator must be able to tell apart, and they are all reachable from the same
     * policy text:
     *
     *   native     — the chain asked for native, a native provider exists, it answered
     *   exhausted  — the chain asked for native, nothing provided it, no fallback declared (a mistake)
     *   none       — the chain ran out AND the consumer said `fallback: ["none"]` (a decision)
     *
     * `none` versus `exhausted` is the difference between "I chose to have no memory" and "I expected
     * memory and it never ran", so collapsing them would hide a misconfiguration.
     */
    const elected = createSourceRegistry(POLICIES({ memory: { prefer: ['native'] } }), [NATIVE_MEMORY]);
    assert.equal(elected.elections().memory.reason, 'native');

    const exhausted = createSourceRegistry(POLICIES({ memory: { prefer: ['native'] } }), []);
    assert.equal(exhausted.elections().memory.reason, 'exhausted', 'no fallback declared, nothing provided');

    const explicitlyNone = createSourceRegistry(POLICIES({ memory: { prefer: ['native'], fallback: ['none'] } }), []);
    assert.equal(explicitlyNone.elections().memory.reason, 'none', 'the consumer declared `none` as the fallback');

    const reasons = [
        elected.elections().memory.reason,
        exhausted.elections().memory.reason,
        explicitlyNone.elections().memory.reason,
    ];
    assert.equal(new Set(reasons).size, 3, 'these three must never look the same to an operator');
});

test('orchestrateTurn carries elections into retrieval, so the verdict can be explained', async () => {
    const registry = createSourceRegistry(POLICIES({ memory: { prefer: ['native'] } }), [NATIVE_MEMORY]);
    const out = await orchestrateTurn(
        { event: 'turn_start', turnId: 'qc-native', userQueryStem: 'what did we ship', touchedPaths: [] },
        {
            policy: POLICIES({ memory: { prefer: ['native'] } }),
            registry,
            injectSnippets: [],
            reads: { readCount: 0 },
        },
    );
    assert.equal(out.retrieval.elections.memory.reason, 'native');
    assert.equal(out.retrieval.elections.memory.providerId, 'native:dsh-session');
});

test('the projection states the election, not just the fetch trace', async () => {
    const registry = createSourceRegistry(POLICIES({ memory: { prefer: ['native'] } }), [NATIVE_MEMORY]);
    const pinned = { requiredDocTerms: [], minReadPaths: 0, lawQueries: [], codeQueries: [] };
    const out = await orchestrateTurn(
        { event: 'turn_start', turnId: 'qc-native-2', userQueryStem: 'what did we ship', touchedPaths: [] },
        { policy: POLICIES({ memory: { prefer: ['native'] } }), registry, skillPacks: { general: pinned }, reads: { readCount: 0 } },
    );
    const projection = buildPreflightProjection(
        { userQueryStem: 'what did we ship' },
        out,
        { policy: POLICIES({ memory: { prefer: ['native'] } }) },
    );

    assert.ok(projection.elections, 'the projection must carry elections');
    assert.equal(projection.elections.memory.reason, 'native');
    assert.equal(projection.elections.memory.providerId, 'native:dsh-session');
});

test('the projection is honest when the chain was exhausted', async () => {
    // No native provider registered, policy still asks for native: the gate must be able to say "the
    // election failed" rather than implying the host answered.
    const policy = POLICIES({ memory: { prefer: ['native'] } });
    const registry = createSourceRegistry(policy, []);
    const out = await orchestrateTurn(
        { event: 'turn_start', turnId: 'qc-exhausted', userQueryStem: 'what did we ship', touchedPaths: [] },
        { policy, registry, reads: { readCount: 0 } },
    );
    const projection = buildPreflightProjection({ userQueryStem: 'what did we ship' }, out, { policy });
    assert.equal(
        projection.elections.memory.reason,
        'exhausted',
        'the policy asked for native and nothing provided it, with no fallback declared — a misconfiguration, and the projection says so',
    );
    assert.equal(projection.elections.memory.providerId, null);
});
