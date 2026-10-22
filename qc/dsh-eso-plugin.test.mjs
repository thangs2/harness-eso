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

test('an ask-tier path is denied by default, because a host ask is not a gate', () => {
    const root = consumer({ paths: { locked: [], gated: [], ask: ['infra/'], sot: [] } });
    const args = { file_path: path.join(root, 'infra/main.tf') };

    const strict = decideToolCall({ root, name: 'edit', args });
    assert.equal(strict.kind, 'deny');
    assert.match(strict.reason, /needs approval/);
    assert.match(strict.reason, /askMode=host/);

    const hosted = decideToolCall({ root, name: 'edit', args, askMode: 'host' });
    assert.equal(hosted.kind, 'ask', 'a consumer that trusts its host approval UI can opt in');
});

test('a gated path with no consent is denied by default and asks on request', () => {
    const root = consumer({ paths: { locked: [], gated: ['AGENTS.md'], ask: [], sot: [] } });
    const args = { path: path.join(root, 'AGENTS.md') };
    assert.equal(decideToolCall({ root, name: 'write', args }).kind, 'deny');
    assert.equal(decideToolCall({ root, name: 'write', args, askMode: 'host' }).kind, 'ask');
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

test('product state alone does not make a directory a consumer', () => {
    // The CLI writes `.harness/` into the product checkout; that is state, not a declaration. Treating
    // it as a marker made the gate police harness-eso itself.
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-dsh-state-'));
    fs.mkdirSync(path.join(checkout, '.harness', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.harness', 'workspace.json'), '{"projects":[]}\n');
    assert.equal(findConsumerRoot(checkout), null);

    // An explicit policy *is* a declaration, even without a config.
    const declared = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-dsh-declared-'));
    fs.mkdirSync(path.join(declared, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(declared, '.harness', 'decision-policy.json'), '{"paths":{"locked":["x/"]}}');
    assert.equal(findConsumerRoot(declared), declared);
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

test('arrow functions and 2>&1 are not redirects', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const arrow = ["python3 - <<'PY'", "open('src/x.js','w').write('y')", 'PY', 'node -e "const f = (a) => a" && echo done'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: arrow } }), null);

    const stderr = ["python3 - <<'PY'", "open('src/x.js','w').write('y')", 'PY', 'node x.mjs 2>&1 | tail -n 2'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: stderr } }), null);

    // A real redirect still counts.
    const writing = ["python3 - <<'PY' > $OUT", "open('x','w').write('y')", 'PY'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: writing } })?.kind, 'deny');
});

test('the word "tee" in prose is not a redirect', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const message = ["git commit -F - <<'EOF'", 'a redirect or `tee` with an unresolvable target keeps the deny', 'EOF'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: message } }), null);

    // `tee` to a variable is intent for the plugin (no event path here), so it is denied unsresolved.
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: 'echo x | tee $TARGET' } })?.kind, 'deny');
});

test('a shell write is gated from its own target, with no root passed in', () => {
    // The live failure this pins: inside DSH the process cwd is the app directory, so a command that
    // writes an absolute path in a consumer was judged with no consumer and allowed.
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const target = path.join(root, 'secrets/a.txt');
    assert.equal(decideToolCall({ name: 'bash', args: { command: `echo x > ${target}` } })?.kind, 'deny');

    const gated = consumer({ paths: { locked: [], gated: ['AGENTS.md'], ask: [], sot: [] } });
    const ask = decideToolCall({ name: 'bash', args: { command: `echo x > ${path.join(gated, 'AGENTS.md')}` } });
    assert.equal(ask?.kind, 'deny', 'gated defaults to deny: the host ask path is not enforcement');
});

test('a heredoc script that writes a protected relative path is still gated', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const command = ["python3 - <<'PY'", "open('secrets/key.txt','w').write('x')", 'PY'].join('\n');
    const decision = decideToolCall({ root, name: 'bash', args: { command } });
    assert.equal(decision?.kind, 'deny');
    assert.match(decision.reason, /secrets\/key\.txt/);
});

test('a heredoc script that writes only writable relative paths proceeds', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const command = ["python3 - <<'PY'", "open('src/app.js','w').write('x')", "open('README.md','a').write('y')", 'PY'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command } }), null);
});

test('a heredoc that names no path at all is not judged', () => {
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    const command = ["python3 - <<'PY'", "print('hello')", 'PY'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command } }), null);
});

test('a redirect to a variable is intent for the plugin, and denied with no resolvable target', () => {
    // The shared matcher ignores `$VAR` targets; the plugin cannot afford to, because unlike the host
    // pack it has no event `path` as a second signal.
    const root = consumer({ paths: { locked: ['secrets/'], gated: [], ask: [], sot: [] } });
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: 'cat data > $TARGET' } })?.kind, 'deny');

    const script = ["python3 - <<'PY' > $OUT", "open('x','w').write('y')", 'PY'].join('\n');
    assert.equal(decideToolCall({ root, name: 'bash', args: { command: script } })?.kind, 'deny');
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
