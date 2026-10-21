import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildContextBlock,
    CORDIS_PRE_STEP,
    createEsoCordisPlugin,
    INSTRUCTIONS_SOURCE,
} from '../packages/harness-host-dsh/src/cordis.mjs';
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

function instructions(text) {
    return {
        role: 'user',
        content: [{ type: 'text', text }],
        source: { ...INSTRUCTIONS_SOURCE, changes: [] },
    };
}

function setup(extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cordis-'));
    const ctx = fakeCtx();
    const plugin = createEsoCordisPlugin({
        root,
        policy: policyWithNativeMemory(),
        searchEvents: async () => [{ text: 'tenant id is request scoped', seq: 1, sessionId: 's' }],
        ...extra,
    });
    plugin.apply(ctx);
    return { ctx, root, handler: ctx.listeners.get(CORDIS_PRE_STEP) };
}

test('the plugin registers exactly agent/pre-step and unwinds', () => {
    const { ctx } = setup();
    assert.deepEqual([...ctx.listeners.keys()], [CORDIS_PRE_STEP]);
    assert.equal(typeof ctx.listeners.get(CORDIS_PRE_STEP), 'function');
});

test('next() returns the decision and the instruction message lands after the last claimed message', async () => {
    const { handler } = setup({ createMessage: instructions });
    const m1 = { role: 'user', content: [{ type: 'text', text: 'tenant id?' }], source: { kind: 'user' } };
    const m2 = { role: 'assistant', content: [{ type: 'text', text: 'checking' }], source: { kind: 'assistant' } };
    const tool = { role: 'tool', content: [{ type: 'text', text: '{}' }], source: { kind: 'tool' } };
    const payload = { agent: {}, messages: [m1, m2], step: 2, signal: { aborted: false } };

    const out = await handler(payload, async () => ({ kind: 'continue', messages: [m1, m2, tool] }));

    assert.equal(out.kind, 'continue');
    assert.equal(out.messages.length, 4);
    assert.equal(out.messages[0], m1);
    assert.equal(out.messages[1], m2);
    assert.equal(out.messages[2].source.kind, 'agent-instructions');
    assert.match(out.messages[2].content[0].text, /ESO preflight:/);
    assert.equal(out.messages[3], tool, 'the block goes before unclaimed tool results, not after them');
});

test('without a host message factory the decision is untouched, not patched with an invented shape', async () => {
    const { handler } = setup();
    const m1 = { role: 'user', content: [{ type: 'text', text: 'tenant id?' }], source: { kind: 'user' } };
    const decision = { kind: 'continue', messages: [m1] };
    const out = await handler({ messages: [m1], signal: {} }, async () => decision);
    assert.equal(out, decision);
    assert.equal(out.messages.length, 1);
});

test('rejectOn turns the preflight result into a hard reject', async () => {
    const { handler } = setup({ rejectOn: () => true });
    const out = await handler({ messages: [], signal: {} }, async () => ({ kind: 'continue', messages: [] }));
    assert.deepEqual(out, { kind: 'reject' }, 'DSH ends the step as blocked without a model request');
});

test('a step the host already rejected is never overwritten', async () => {
    const { handler } = setup({ rejectOn: () => true, createMessage: instructions });
    const rejected = { kind: 'reject' };
    const out = await handler({ messages: [], signal: {} }, async () => rejected);
    assert.equal(out, rejected);
});

test('an aborted step does not run preflight', async () => {
    let called = false;
    const { handler } = setup({
        searchEvents: async () => {
            called = true;
            return [];
        },
    });
    const decision = { kind: 'continue', messages: [] };
    const out = await handler({ messages: [], signal: { aborted: true } }, async () => decision);
    assert.equal(out, decision);
    assert.equal(called, false);
});

test('a failing preflight proceeds instead of ending the turn', async () => {
    const { handler } = setup({
        root: '/nonexistent-root-for-cordis-test',
        searchEvents: async () => {
            throw new Error('boom');
        },
        rejectOn: () => true,
    });
    const decision = { kind: 'continue', messages: [] };
    const out = await handler({ messages: [], signal: {} }, async () => decision);
    assert.equal(out, decision, 'the original decision survives a provider failure');
});

test('a sufficient verdict with nothing to act on adds no context', () => {
    assert.equal(buildContextBlock({ verdict: { sufficiency: { level: 'sufficient', score: 1 } }, gaps: [] }), '');
    assert.equal(buildContextBlock({ skipped: true }), '');
    assert.equal(buildContextBlock({}), '');
    assert.match(
        buildContextBlock({ verdict: { sufficiency: { level: 'insufficient', score: 0 } }, gaps: [{ kind: 'law' }] }),
        /insufficient/,
    );
});

test('a declared migration check rejects the step before a model request', async () => {
    const { root, handler } = setup();
    fs.writeFileSync(path.join(root, '001-drop.sql'), 'drop table orders;');
    const ctx = fakeCtx();
    createEsoCordisPlugin({
        root,
        policy: policyWithNativeMemory(),
        checks: { migration: { files: ['001-drop.sql'] } },
    }).apply(ctx);
    const out = await ctx.listeners.get(CORDIS_PRE_STEP)({ messages: [], signal: {} }, async () => ({
        kind: 'continue',
        messages: [],
    }));
    assert.deepEqual(out, { kind: 'reject' });
    assert.equal(typeof handler, 'function');
});

test('a declared check that finds nothing leaves the decision alone', async () => {
    const { root, handler } = setup();
    fs.writeFileSync(path.join(root, '001-add.sql'), 'create table orders (id integer);');
    const ctx = fakeCtx();
    createEsoCordisPlugin({
        root,
        policy: policyWithNativeMemory(),
        checks: { migration: { files: ['001-add.sql'] } },
    }).apply(ctx);
    const decision = { kind: 'continue', messages: [] };
    const out = await ctx.listeners.get(CORDIS_PRE_STEP)({ messages: [], signal: {} }, async () => decision);
    assert.equal(out, decision);
    assert.equal(typeof handler, 'function');
});
