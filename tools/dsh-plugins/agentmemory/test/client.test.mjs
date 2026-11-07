/**
 * The stdio MCP client against the offline fixture server.
 *
 * These are the transport facts the plugin depends on: handshake, tool listing,
 * JSON-RPC errors surfacing as rejections, timeouts, and a non-JSON banner on
 * stdout being skippable (real MCP servers print one).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { McpError, StdioMcpClient, resultText } from '../src/mcp-stdio-client.mjs';
import { FIXTURE, makeWorkspace, readEvents, removeWorkspace } from './helpers.mjs';

function makeClient(workspace, args = [], options = {}) {
    return new StdioMcpClient({
        command: process.execPath,
        args: [FIXTURE, '--log', join(workspace, 'events.jsonl'), ...args],
        name: 'agentmemory:test',
        cwd: workspace,
        timeoutMs: 5_000,
        ...options,
    });
}

test('handshake, tool list and a tool call work over stdio', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace);
    try {
        await client.connect();
        assert.equal(client.serverInfo?.name, 'agentmemory');
        assert.equal(client.protocolVersion, '2025-06-18');
        assert.deepEqual(
            client.tools.map((tool) => tool.name),
            ['memory_smart_search', 'memory_save', 'memory_fail'],
        );

        const result = await client.callTool('memory_smart_search', { query: 'harness' });
        const payload = JSON.parse(resultText(result));
        assert.equal(payload.tool, 'memory_smart_search');
        assert.deepEqual(payload.args, { query: 'harness' });
        assert.equal(payload.cwd, realpathSync(workspace));

        const calls = readEvents(join(workspace, 'events.jsonl')).filter((event) => event.event === 'call');
        assert.equal(calls.length, 1);
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});

test('a JSON-RPC error from the server rejects with the server message', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace);
    try {
        await client.connect();
        await assert.rejects(
            () => client.callTool('memory_fail', {}),
            (error) => {
                assert.ok(error instanceof McpError);
                assert.equal(error.code, -32000);
                assert.match(error.message, /fixture failure/);
                return true;
            },
        );
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});

test('a hanging call times out instead of wedging the session', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace, ['--hang', 'memory_hang', '--tools', 'memory_smart_search,memory_hang'], {
        timeoutMs: 150,
    });
    try {
        await client.connect();
        await assert.rejects(() => client.callTool('memory_hang', {}), (error) => {
            assert.ok(error instanceof McpError);
            assert.equal(error.code, 'TIMEOUT');
            return true;
        });
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});

test('initialize failure is reported with the server message', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace, ['--fail-init']);
    try {
        await assert.rejects(() => client.connect(), (error) => {
            assert.ok(error instanceof McpError);
            assert.match(error.message, /fixture init failure/);
            return true;
        });
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});

test('closing is idempotent and a closed client rejects further calls', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace);
    await client.connect();
    await client.close();
    await client.close();
    assert.equal(client.connected, false);
    await assert.rejects(() => client.callTool('memory_smart_search', { query: 'x' }), (error) => {
        assert.equal(error.code, 'NOT_CONNECTED');
        return true;
    });
    removeWorkspace(workspace);
});

test('a missing server binary rejects with SPAWN_FAILED, not a raw Error', async () => {
    const workspace = makeWorkspace({});
    const client = new StdioMcpClient({
        command: join(workspace, 'no-such-mcp-server'),
        args: [],
        name: 'agentmemory:missing',
        timeoutMs: 1_000,
    });
    try {
        await assert.rejects(() => client.connect(), (error) => {
            assert.ok(error instanceof McpError);
            assert.equal(error.code, 'SPAWN_FAILED');
            return true;
        });
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});

test('an aborted call rejects with CANCELLED and does not wait for the timeout', async () => {
    const workspace = makeWorkspace({});
    const client = makeClient(workspace, ['--hang', 'memory_hang', '--tools', 'memory_smart_search,memory_hang'], {
        timeoutMs: 30_000,
    });
    try {
        await client.connect();
        const controller = new AbortController();
        const started = Date.now();
        const call = client.callTool('memory_hang', {}, controller.signal);
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(() => call, (error) => {
            assert.ok(error instanceof McpError);
            assert.equal(error.code, 'CANCELLED');
            return true;
        });
        assert.ok(Date.now() - started < 2_000);
    } finally {
        await client.close();
        removeWorkspace(workspace);
    }
});
