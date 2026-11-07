/**
 * The plugin lifecycle against a fake DSH context and a fake MCP server.
 *
 * The assertions are about observable behaviour, not implementation: which tools
 * appear on which agent, what environment the server actually received, and what
 * happens on the lifecycle edges (`agent/disposed` during install, plugin
 * unload, bootstrap of already-live agents).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { buildServerEnv, createAgentMemoryPlugin, inject } from '../src/plugin.mjs';
import {
    FIXTURE,

    createFakeAgent,
    createFakeContext,
    makeWorkspace,
    readEvents,
    removeWorkspace,
    sleep,
    waitFor,
} from './helpers.mjs';

/** A workspace with an AgentMemory entry in the Cursor dialect, like the real repos. */
function makeRepo(url = 'http://localhost:3211', env = {}) {
    return makeWorkspace({
        '.cursor/mcp.json': {
            mcpServers: { agentmemory: { command: 'npx', env: { AGENTMEMORY_URL: url, ...env } } },
        },
    });
}

function makeConfig(workspace, overrides = {}) {
    return {
        serverCommand: process.execPath,
        serverArgs: [FIXTURE, '--log', join(workspace, 'events.jsonl')],
        timeoutMs: 5_000,
        probeImpl: async () => ({ ok: true }),
        ...overrides,
    };
}

test('every Cordis service the plugin reads is declared in inject', () => {
    // Measured on DSH 0.2.2-rc.1: `ctx.workingDirectory`/`ctx.agents` are proxies
    // that THROW `cannot get property "…" without inject`. A try/catch around the
    // read turns that into a silent "0 tools, 0 log lines" session, which is the
    // exact failure this assertion exists to prevent.
    assert.ok(inject.includes('tools'));
    assert.ok(inject.includes('workingDirectory'));
});

test('registers the server tools for a configured repo only', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'three registered tools' });

        assert.deepEqual([...tools.keys()].sort(), ['memory_fail', 'memory_save', 'memory_smart_search']);

        const definition = tools.get('memory_smart_search');
        assert.match(definition.description, /AgentMemory store/);
        assert.equal(definition.name, 'memory_smart_search');

        const value = await definition.execute({ query: 'hello' });
        assert.equal(value.isError, undefined);
        const payload = JSON.parse(value.text);
        assert.equal(payload.tool, 'memory_smart_search');
        assert.deepEqual(payload.args, { query: 'hello' });
        assert.equal(payload.cwd, realpathSync(workspace));
        assert.equal(payload.url, 'http://localhost:3211');

        const start = readEvents(join(workspace, 'events.jsonl')).find((event) => event.event === 'start');
        assert.equal(start.url, 'http://localhost:3211');
        assert.equal(start.forceProxy, '1');
        assert.equal(start.cwd, realpathSync(workspace));
        assert.ok(ctx.logs.info.some((line) => /registered 3 tools for localhost:3211/.test(line)));
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('resolves the directory through workingDirectory.ensure when get is still empty', async () => {
    // A freshly created agent has no committed directory projection yet; `ensure`
    // is the API that validates and returns the effective directory.
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    ctx.workingDirectory.get = () => null;
    let ensured = 0;
    ctx.workingDirectory.ensure = async () => {
        ensured += 1;
        return workspace;
    };
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'tools after ensure' });
        assert.equal(ensured, 1);
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('a repo with no AgentMemory config registers nothing and spawns nothing', async () => {
    const workspace = makeWorkspace({});
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await sleep(200);
        assert.equal(tools.size, 0);
        assert.deepEqual(readEvents(join(workspace, 'events.jsonl')), []);
        assert.equal(ctx.logs.info.length, 0);
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('a secret is resolved from the DSH store and handed to the server explicitly', async () => {
    const workspace = makeWorkspace({
        '.dsh/agentmemory.json': { url: 'https://memory.example.com', credential: 'AM_REF', agentScope: 'isolated' },
    });
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace }, credentials: { AM_REF: 'store-secret' } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'three registered tools' });

        const start = readEvents(join(workspace, 'events.jsonl')).find((event) => event.event === 'start');
        assert.equal(start.url, 'https://memory.example.com');
        assert.equal(start.secret, 'store-secret');
        assert.equal(start.credentialMode, 'explicit');
        assert.equal(start.agentScope, 'isolated');
        assert.ok(ctx.logs.info.some((line) => /secret from credentials:AM_REF/.test(line)));
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('an unreachable server registers no tools and explains why', async () => {
    const workspace = makeRepo('http://localhost:3999');
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(
            ctx,
            makeConfig(workspace, { probeImpl: async () => ({ ok: false, reason: 'ECONNREFUSED' }) }),
        );
        // Must not reject agent creation.
        await ctx.emit('agent/created', { agent });
        await sleep(100);
        assert.equal(tools.size, 0);
        assert.deepEqual(readEvents(join(workspace, 'events.jsonl')), []);
        assert.ok(ctx.logs.info.some((line) => /no AgentMemory server answering at http:\/\/localhost:3999.*ECONNREFUSED/.test(line)));
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('failOnStartupError only raises the log level; it never rejects agent creation', async () => {
    const workspace = makeRepo('http://localhost:3999');
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(
            ctx,
            makeConfig(workspace, {
                probeImpl: async () => ({ ok: false, reason: 'ECONNREFUSED' }),
                failOnStartupError: true,
            }),
        );
        await ctx.emit('agent/created', { agent });
        assert.equal(ctx.logs.error.length, 1);
        assert.match(ctx.logs.error[0], /no AgentMemory server answering/);
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('toolPrefix is applied without doubling the server name', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace, { toolPrefix: 'am_' }));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'prefixed tools' });
        assert.deepEqual([...tools.keys()].sort(), ['am_memory_fail', 'am_memory_save', 'am_memory_smart_search']);
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('a tool-level error is returned as an isError value with the server message', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'three registered tools' });
        const value = await tools.get('memory_fail').execute({});
        assert.equal(value.isError, true);
        assert.match(value.text, /fixture failure/);
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('agents alive before activation are seeded (plugin-manager enable / HMR)', async () => {
    const workspace = makeRepo();
    const { agent, tools } = createFakeAgent('live');
    const ctx = createFakeContext({ services: inject, dirs: { live: workspace }, existingAgents: [agent] });
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await waitFor(() => tools.size === 3, { label: 'bootstrap tools' });
        assert.ok(ctx.logs.info.some((line) => /registered 3 tools for localhost:3211/.test(line)));
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('an event without an agent payload is ignored, not a crash', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', {});
        await ctx.emit('agent/disposed', {});
        assert.ok(ctx.logs.info.some((line) => /without an agent payload/.test(line)));
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('duplicate created events do not spawn a second server', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await Promise.all([ctx.emit('agent/created', { agent }), ctx.emit('agent/created', { agent })]);
        await waitFor(() => tools.size === 3, { label: 'three registered tools' });
        const starts = readEvents(join(workspace, 'events.jsonl')).filter((event) => event.event === 'start');
        assert.equal(starts.length, 1);
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('disposing the agent mid-handshake tears the session down instead of leaking it', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace, { serverArgs: [FIXTURE, '--log', join(workspace, 'events.jsonl'), '--delay', '250'] }));
        const created = ctx.emit('agent/created', { agent });
        await sleep(50); // dispose while initialize is still delayed
        await ctx.emit('agent/disposed', { agent });
        await created;
        await waitFor(
            () => readEvents(join(workspace, 'events.jsonl')).some((event) => event.event === 'exit'),
            { label: 'server exit after mid-install dispose' },
        );
        assert.equal(tools.size, 0);
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('plugin unload disposes tools and closes live MCP processes', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 3, { label: 'three registered tools' });
        ctx.cleanup();
        assert.equal(tools.size, 0);
        await waitFor(
            () => readEvents(join(workspace, 'events.jsonl')).some((event) => event.event === 'exit'),
            { label: 'server exit after plugin unload' },
        );
    } finally {
        removeWorkspace(workspace);
    }
});

test('buildServerEnv keeps the invariants a repo config cannot override', () => {
    const target = {
        url: 'http://localhost:3211',
        viewerUrl: 'http://localhost:3213',
        agentScope: 'isolated',
        credentialMode: null,
        extraEnv: {
            AGENTMEMORY_ENV_FILE: '/tmp/x.env',
            // A repo must not be able to turn the fallback back on.
            AGENTMEMORY_FORCE_PROXY: '0',
            AGENTMEMORY_URL: 'http://localhost:9999',
        },
    };
    const env = buildServerEnv(target, null);
    assert.equal(env.AGENTMEMORY_URL, 'http://localhost:3211');
    assert.equal(env.AGENTMEMORY_FORCE_PROXY, '1');
    assert.equal(env.AGENTMEMORY_VIEWER_URL, 'http://localhost:3213');
    assert.equal(env.AGENTMEMORY_AGENT_SCOPE, 'isolated');
    assert.equal(env.AGENTMEMORY_ENV_FILE, '/tmp/x.env');
    assert.equal(env.AGENTMEMORY_SECRET, undefined);

    const withSecret = buildServerEnv(target, 's3cr3t');
    assert.equal(withSecret.AGENTMEMORY_SECRET, 's3cr3t');
    assert.equal(withSecret.AGENTMEMORY_CREDENTIAL_MODE, 'explicit');

    const insecure = buildServerEnv(target, null, { insecureTls: true });
    assert.equal(insecure.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test('a broken explicit config is reported instead of resolving a parent server', async () => {
    const workspace = makeWorkspace({
        '.dsh/agentmemory.json': '{ not json',
        '.cursor/mcp.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3211' } } } },
    });
    let probes = 0;
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(
            ctx,
            makeConfig(workspace, {
                probeImpl: async () => {
                    probes += 1;
                    return { ok: true };
                },
            }),
        );
        await ctx.emit('agent/created', { agent });
        await sleep(100);
        assert.equal(tools.size, 0);
        assert.equal(probes, 0, 'must not probe a server resolved from another repo');
        assert.ok(ctx.logs.info.some((line) => /cannot parse AgentMemory config .*agentmemory\.json/.test(line)));
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('a non-object agent payload is ignored instead of rejecting agent creation', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    try {
        createAgentMemoryPlugin().apply(ctx, makeConfig(workspace));
        // `installing.add(agent)` on a truthy non-object throws inside a WeakSet and
        // would reject the awaited agent/created listener (killing registration).
        await ctx.emit('agent/created', { agent: 'not-an-agent' });
        assert.ok(ctx.logs.info.some((line) => /without an agent payload/.test(line)));
    } finally {
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});

test('a cancelled tool call returns promptly instead of waiting out the timeout', async () => {
    const workspace = makeRepo();
    const ctx = createFakeContext({ services: inject, dirs: { s1: workspace } });
    const { agent, tools } = createFakeAgent('s1');
    try {
        createAgentMemoryPlugin().apply(
            ctx,
            makeConfig(workspace, {
                timeoutMs: 30_000,
                serverArgs: [
                    FIXTURE,
                    '--log',
                    join(workspace, 'events.jsonl'),
                    '--tools',
                    'memory_smart_search,memory_slow',
                    '--hang',
                    'memory_slow',
                ],
            }),
        );
        await ctx.emit('agent/created', { agent });
        await waitFor(() => tools.size === 2, { label: 'two registered tools' });

        const controller = new AbortController();
        const started = Date.now();
        const call = tools.get('memory_slow').execute({}, { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const value = await call;
        assert.equal(value.isError, true);
        assert.match(value.text, /cancel/i);
        assert.ok(Date.now() - started < 2_000, 'cancellation must not wait for the 30 s timeout');
    } finally {
        await ctx.emit('agent/disposed', { agent });
        ctx.cleanup();
        removeWorkspace(workspace);
    }
});
