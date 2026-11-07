#!/usr/bin/env node
/**
 * Minimal fake AgentMemory MCP server for offline tests.
 *
 * Speaks just enough MCP 2025-06-18 over stdio: initialize,
 * notifications/initialized, tools/list, tools/call. It also writes lifecycle
 * events to a log file so a test can assert what the plugin actually spawned —
 * cwd, resolved URL, secret, FORCE_PROXY — instead of trusting the plugin's log.
 *
 * Usage (the plugin's `serverArgs` carry these flags; the fixture's env is
 * exactly what the plugin built, which is the point):
 *   node mcp-server.mjs --log <path> [--delay <ms>] [--tools a,b] [--hang a,b]
 *                       [--fail-init] [--no-banner]
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function flag(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const logPath = flag('--log', '');
const delayMs = Number(flag('--delay', '0')) || 0;
const toolNames = (flag('--tools', 'memory_smart_search,memory_save,memory_fail') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
const hangTools = new Set(
    (flag('--hang', '') ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
);

function record(event) {
    if (!logPath) return;
    try {
        appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
    } catch {
        /* a test log must never break the fixture */
    }
}

record({
    event: 'start',
    pid: process.pid,
    cwd: process.cwd(),
    url: process.env.AGENTMEMORY_URL ?? null,
    viewerUrl: process.env.AGENTMEMORY_VIEWER_URL ?? null,
    secret: process.env.AGENTMEMORY_SECRET ?? null,
    forceProxy: process.env.AGENTMEMORY_FORCE_PROXY ?? null,
    credentialMode: process.env.AGENTMEMORY_CREDENTIAL_MODE ?? null,
    agentScope: process.env.AGENTMEMORY_AGENT_SCOPE ?? null,
    tlsDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
});

// A server that prints a banner to stdout is common; the client must skip it.
if (!process.argv.includes('--no-banner')) process.stdout.write('fixture agentmemory mcp starting\n');

const tools = toolNames.map((toolName) => ({
    name: toolName,
    description: `Fixture tool ${toolName}`,
    inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, content: { type: 'string' } },
        additionalProperties: true,
    },
}));

function send(payload) {
    try {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch {
        /* parent closed the pipe */
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

readline.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
        message = JSON.parse(trimmed);
    } catch {
        return;
    }

    const respond = (payload) => send({ jsonrpc: '2.0', id: message.id, ...payload });

    if (message.method === 'initialize') {
        if (delayMs > 0) await sleep(delayMs);
        if (process.argv.includes('--fail-init')) {
            respond({ error: { code: -32603, message: 'fixture init failure' } });
            return;
        }
        respond({
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'agentmemory', version: 'fixture-1.0.0' },
            },
        });
        return;
    }

    if (message.method === 'notifications/initialized') return;

    if (message.method === 'tools/list') {
        respond({ result: { tools } });
        return;
    }

    if (message.method === 'tools/call') {
        const toolName = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (hangTools.has(toolName)) {
            await sleep(60_000);
            return;
        }
        if (toolName === 'memory_fail') {
            respond({ error: { code: -32000, message: 'fixture failure' } });
            return;
        }
        record({ event: 'call', tool: toolName, args });
        respond({
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            tool: toolName,
                            args,
                            cwd: process.cwd(),
                            url: process.env.AGENTMEMORY_URL ?? null,
                        }),
                    },
                ],
            },
        });
        return;
    }

    if (typeof message.id !== 'undefined') {
        respond({ error: { code: -32601, message: `method not found: ${message.method}` } });
    }
});

function shutdown() {
    record({ event: 'exit', pid: process.pid });
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
readline.on('close', shutdown);
