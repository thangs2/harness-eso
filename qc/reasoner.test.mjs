import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalReasoner, createHostReasoner, delegateReasoning } from '../packages/harness-eso-core/src/reasoner.mjs';

const policy = { eso: { reasoner: { prefer: ['native:host-model'], fallback: ['deepseek-mcp'] } } };
const native = createHostReasoner({ delegate: async () => ({ text: 'native answer' }) });
const external = createExternalReasoner({ delegate: async () => ({ text: 'paid answer' }) });

test('the native reasoner wins when healthy', async () => {
    const out = await delegateReasoning({ task: { prompt: 'design the migration' }, policy, providers: [native, external] });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'native:host-model');
    assert.equal(out.text, 'native answer');
    assert.equal(out.paid, false);
});

test('a spent budget skips the paid provider instead of calling it', async () => {
    let called = 0;
    const paid = createExternalReasoner({ delegate: async () => (called += 1, { text: 'no' }) });
    const out = await delegateReasoning({
        task: { prompt: 'x' },
        policy: { eso: { reasoner: { prefer: ['deepseek-mcp'] } } },
        providers: [paid],
        budget: { remainingUsd: 0 },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_provider_or_budget');
    assert.equal(called, 0);
});

test('a provider failure is reported, not silently replaced', async () => {
    const broken = createHostReasoner({ delegate: async () => { throw new Error('boom'); } });
    const out = await delegateReasoning({ task: { prompt: 'x' }, policy, providers: [broken] });
    assert.equal(out.ok, false);
    assert.match(out.reason, /reasoner_error:boom/);
});

test('a task without a prompt is rejected', async () => {
    await assert.rejects(() => delegateReasoning({ task: { prompt: '  ' }, policy, providers: [native] }), /prompt is required/);
    assert.throws(() => createHostReasoner({}), /delegate must be a function/);
});
