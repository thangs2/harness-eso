import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideToolCall, findConsumerRoot, resolveRoot } from '../packages/harness-eso-dsh/src/guards.mjs';
import { createEsoDshPlugin } from '../packages/harness-eso-dsh/src/plugin.mjs';
import pluginDefault from '../packages/harness-eso-dsh/src/plugin.mjs';

function consumer({ paths, projectId = 'opt' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-dsh-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: projectId } }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'fail_closed' },
            ...(paths ? { paths } : {}),
        }),
    );
    return root;
}

function fakeCtx() {
    const listeners = new Map();
    return {
        listeners,
        logger: { info: () => {} },
        on(event, fn) {
            listeners.set(event, fn);
            return () => listeners.delete(event);
        },
    };
}

const dispatch = (handler, ...args) => handler(...args);

test('the plugin object is the shape DSH loads, with no injected services', () => {
    assert.equal(pluginDefault.name, 'harness-eso');
    assert.deepEqual(pluginDefault.inject, []);
    assert.equal(typeof pluginDefault.apply, 'function');
});

test('it registers the tool gate and the pre-step seam, and unwinds', () => {
    const ctx = fakeCtx();
    const dispose = createEsoDshPlugin().apply(ctx);
    assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/pre-step', 'tools/pre-execute']);
    dispose();
    assert.equal(ctx.listeners.size, 0);
});

test('a locked path is denied with a reason the model can read', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const decision = decideToolCall({ root, name: 'write', args: { path: path.join(root, 'secrets/key.txt') } });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /secrets\/key\.txt is locked/);
    assert.equal(decision.path, 'secrets/key.txt');
});

test('an ask-tier path asks instead of denying', () => {
    const root = consumer({ paths: { locked: [], gated: [], ask: ['infra/'], sot: [] } });
    const decision = decideToolCall({ root, name: 'edit', args: { file_path: path.join(root, 'infra/main.tf') } });
    assert.equal(decision.kind, 'ask');
    assert.match(decision.reason, /needs approval/);
});

test('a gated path asks when there is no live consent, and allows when there is', () => {
    const root = consumer({ paths: { locked: [], gated: ['AGENTS.md'], ask: [], sot: [] } });
    const target = { path: path.join(root, 'AGENTS.md') };
    assert.equal(decideToolCall({ root, name: 'write', args: target }).kind, 'ask');
});

test('a writable path is no opinion at all', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    assert.equal(decideToolCall({ root, name: 'write', args: { path: path.join(root, 'src/app.js') } }), null);
});

test('the shell channel is gated too, because B5 counts both channels', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const decision = decideToolCall({ root, name: 'bash', args: { command: 'echo x > secrets/key.txt' } });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /secrets\/key\.txt/);
});

test('a read-only shell command is allowed, and an unparseable write is denied', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: 'ls -la' } }), null);

    const unparseable = decideToolCall({ root, name: 'bash', args: { command: 'echo x | tee $TARGET' } });
    if (unparseable) assert.equal(unparseable.kind, 'deny');
});

test('a directory that is not an ESO consumer gets no opinion', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-dsh-plain-'));
    assert.equal(findConsumerRoot(plain), null);
    assert.equal(decideToolCall({ root: null, name: 'write', args: { path: path.join(plain, 'x') } }), null);
});

test('the root is found by walking up from the written path', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const deep = path.join(root, 'secrets', 'nested', 'file.txt');
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    assert.equal(resolveRoot({ args: { path: deep } }), root);
    assert.equal(resolveRoot({ configRoot: root }), root);
});

test('a tool call the gate cannot parse proceeds instead of throwing', async () => {
    const ctx = fakeCtx();
    createEsoDshPlugin().apply(ctx);
    const handler = ctx.listeners.get('tools/pre-execute');
    let called = false;
    const out = await dispatch(handler, { name: 'write', arguments: null }, async () => {
        called = true;
        return { kind: 'allow' };
    });
    assert.equal(called, true);
    assert.deepEqual(out, { kind: 'allow' });
});

test('the handler returns deny straight from the gate without calling next()', async () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const ctx = fakeCtx();
    const decisions = [];
    createEsoDshPlugin({ root, onDecision: (d) => decisions.push(d) }).apply(ctx);
    const handler = ctx.listeners.get('tools/pre-execute');
    let nextCalled = false;
    const out = await handler(
        { name: 'write', arguments: { path: path.join(root, 'secrets/x') } },
        async () => {
            nextCalled = true;
            return { kind: 'allow' };
        },
    );
    assert.equal(nextCalled, false);
    assert.equal(out.kind, 'deny');
    assert.equal(decisions[0].kind, 'deny');
    assert.equal(decisions[0].event, 'tools/pre-execute');
});

test('the pre-step seam never changes an upstream decision', async () => {
    const ctx = fakeCtx();
    createEsoDshPlugin().apply(ctx);
    const handler = ctx.listeners.get('agent/pre-step');
    const rejected = { kind: 'reject' };
    assert.equal(await handler({ turn: 1 }, async () => rejected), rejected);
    const entered = { kind: 'enter', messages: [] };
    assert.equal(await handler({ turn: 2 }, async () => entered), entered);
});
