import assert from 'node:assert/strict';
import test from 'node:test';

import { createJevVerifier, resolveVerifierMode, verifyClaim } from '../packages/harness-eso-core/src/verifier.mjs';

function policy(verifier) {
    return { eso: { verifier } };
}

const allowProvider = {
    id: 'fake-verifier',
    kinds: ['verifier'],
    claims: ['ROUTE', 'GUARD'],
    paid: true,
    async verify() {
        return { verdict: 'allow', confidence: 0.8, reason: 'looks fine' };
    },
};

test('off returns the host verdict without calling the provider', async () => {
    let called = 0;
    const provider = { ...allowProvider, verify: async () => (called += 1, { verdict: 'deny' }) };
    const out = await verifyClaim({ claim: 'GUARD', hostVerdict: 'ask', policy: policy({ mode: 'off' }), providers: [provider] });
    assert.equal(out.verdict, 'ask');
    assert.equal(out.source, 'host-policy');
    assert.equal(out.reason, 'verifier_off');
    assert.equal(called, 0);
});

test('shadow keeps the host verdict and records the disagreement', async () => {
    const out = await verifyClaim({
        claim: 'GUARD',
        hostVerdict: 'allow',
        policy: policy({ mode: 'shadow', prefer: ['fake-verifier'] }),
        providers: [allowProvider],
    });
    assert.equal(out.verdict, 'allow', 'shadow never enforces');
    assert.deepEqual(out.shadowDiff, { host: 'allow', verifier: 'allow', agree: true });
    assert.equal(out.source, 'fake-verifier');
});

test('active takes the provider verdict', async () => {
    const out = await verifyClaim({
        claim: 'ROUTE',
        hostVerdict: 'ask',
        policy: policy({ mode: 'active', prefer: ['fake-verifier'] }),
        providers: [allowProvider],
    });
    assert.equal(out.verdict, 'allow');
    assert.equal(out.source, 'fake-verifier');
    assert.equal(out.confidence, 0.8);
});

test('modes can differ per claim', async () => {
    const p = policy({ mode: 'shadow', modes: { GUARD: 'active' }, prefer: ['fake-verifier'] });
    assert.equal(resolveVerifierMode(p, 'ROUTE'), 'shadow');
    assert.equal(resolveVerifierMode(p, 'GUARD'), 'active');
    const out = await verifyClaim({ claim: 'GUARD', hostVerdict: 'ask', policy: p, providers: [allowProvider] });
    assert.equal(out.verdict, 'allow');
});

test('a paid provider is not called when the budget is spent', async () => {
    let called = 0;
    const provider = { ...allowProvider, verify: async () => (called += 1, { verdict: 'deny' }) };
    const out = await verifyClaim({
        claim: 'GUARD',
        hostVerdict: 'ask',
        policy: policy({ mode: 'active', prefer: ['fake-verifier'] }),
        providers: [provider],
        budget: { remainingPaidCalls: 0 },
    });
    assert.equal(out.verdict, 'ask');
    assert.equal(out.reason, 'budget_exhausted');
    assert.equal(out.degraded, true);
    assert.equal(called, 0);
});

test('a failing provider falls back unless the policy says deny', async () => {
    const broken = { ...allowProvider, verify: async () => { throw new Error('timeout'); } };
    const fallback = await verifyClaim({
        claim: 'GUARD',
        hostVerdict: 'ask',
        policy: policy({ mode: 'active', prefer: ['fake-verifier'] }),
        providers: [broken],
    });
    assert.equal(fallback.verdict, 'ask');
    assert.match(fallback.reason, /verifier_error:timeout/);

    const denied = await verifyClaim({
        claim: 'GUARD',
        hostVerdict: 'ask',
        policy: policy({ mode: 'active', prefer: ['fake-verifier'], onUnavailable: 'deny' }),
        providers: [broken],
    });
    assert.equal(denied.verdict, 'deny');
});

test('a provider that does not declare the claim is skipped', async () => {
    const routeOnly = { ...allowProvider, claims: ['ROUTE'] };
    const out = await verifyClaim({
        claim: 'GUARD',
        hostVerdict: 'ask',
        policy: policy({ mode: 'active', prefer: ['fake-verifier'] }),
        providers: [routeOnly],
    });
    assert.equal(out.verdict, 'ask');
    assert.equal(out.reason, 'no_provider');
});

test('the JEV adapter normalises the answer and declares itself paid', async () => {
    assert.throws(() => createJevVerifier({}), /callJev must be a function/);
    const provider = createJevVerifier({ callJev: async () => ({ verdict: 'deny', confidence: 0.95 }) });
    assert.equal(provider.paid, true);
    assert.deepEqual(provider.modes, ['shadow', 'active']);
    const answer = await provider.verify({ claim: 'GUARD' });
    assert.equal(answer.verdict, 'deny');
    assert.equal(answer.confidence, 0.95);
});
