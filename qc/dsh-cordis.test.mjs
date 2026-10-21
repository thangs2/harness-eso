import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContextBlock, createEsoCordisPlugin } from '../packages/harness-host-dsh/src/cordis.mjs';
import { policyWithNativeMemory } from './fixtures/host-runtime-fixture.mjs';

function fakeCtx() {
    const listeners = new Map();
    return {
        listeners,
        on(event, fn) {
            listeners.set(event, fn);
            return () => listeners.delete(event);
        },
    };
}

test('the plugin adds one additional context and delegates through next()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cordis-'));
    const ctx = fakeCtx();
    const plugin = createEsoCordisPlugin({
        root,
        policy: policyWithNativeMemory(),
        searchEvents: async () => [{ text: 'tenant id is request scoped', seq: 1, sessionId: 's' }],
    });

    const dispose = plugin.apply(ctx);
    assert.equal(typeof dispose, 'function');
    const handler = ctx.listeners.get('agent/pre-step');
    assert.equal(typeof handler, 'function');

    const decision = { turnId: 't1', userQueryStem: 'tenant id' };
    const out = await handler(decision, (value) => value);
    assert.equal(out.additionalContexts.length, 1);
    assert.match(out.additionalContexts[0], /ESO preflight:/);
    assert.equal(out.turnId, 't1', 'the decision is spread, not replaced');

    dispose();
    assert.equal(ctx.listeners.has('agent/pre-step'), false);
});

test('a sufficient verdict with nothing to act on adds no context', () => {
    assert.equal(buildContextBlock({ verdict: { sufficiency: { level: 'sufficient', score: 1 } }, gaps: [] }), '');
    assert.equal(buildContextBlock({ verdict: { sufficiency: { level: 'insufficient', score: 0 } }, gaps: [{ kind: 'law' }] }).includes('insufficient'), true);
});

test('a failing preflight proceeds instead of ending the turn', async () => {
    const ctx = fakeCtx();
    const plugin = createEsoCordisPlugin({
        root: '/nonexistent-root-for-cordis-test',
        policy: policyWithNativeMemory(),
        searchEvents: async () => { throw new Error('boom'); },
    });
    plugin.apply(ctx);
    const decision = { turnId: 't3' };
    const out = await ctx.listeners.get('agent/pre-step')(decision, (v) => v);
    assert.equal(out, decision, 'the original decision survives a provider failure');
});

test('buildContextBlock stays empty without a verdict', () => {
    assert.equal(buildContextBlock({ skipped: true }), '');
    assert.equal(buildContextBlock({}), '');
});
