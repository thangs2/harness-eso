/**
 * Minimal MCP stdio client — JSON-RPC 2.0 over a child process's stdio.
 *
 * Why hand-written: `@deepseek-ai/dsh-mcp-client` is a Loader row, not a library.
 * Installed 0.2.2-rc.1 exports `{ Config, apply, createMcpToolDefinition,
 * inject, name }` — useful for a static row, but it offers no `createClient()`
 * to mount per-session. This file therefore stays dependency-free on purpose:
 * a host plugin that imports `@deepseek-ai/*` can hoist a second copy of a
 * Harness singleton into the profile, which the sibling Jira plugin records as
 * ATF-OPS-001 (the same reason `@mu/harness-eso-dsh` ships a zero-dependency
 * bundle). Note: that failure mode was not re-measured against 0.2.2-rc.1 —
 * the `TOOL_RUNTIME_SCHEDULER` symbol the sibling READMEs cite does not exist
 * in this build — so the constraint is kept as a rule, not as a claim.
 *
 * This file therefore imports only `node:*`. Nothing else may be added here.
 *
 * Protocol notes (MCP 2025-06-18):
 *  - `initialize` then `notifications/initialized`, then `tools/list`.
 *  - A response may arrive before we expect it (server-initiated requests),
 *    so every message is routed by id, not by arrival order.
 *  - stdio framing is newline-delimited JSON. Servers occasionally log to
 *    stdout; a line that does not parse is skipped, not fatal.
 *
 * Measured against `@agentmemory/mcp` 0.9.32: handshake + tools/list against a
 * live server takes ~46 ms with a direct `node` entrypoint, ~0.7 s through
 * `npx` (warm cache). The client buffers the server's stderr tail so a startup
 * failure can be reported with the server's own words instead of "no tools".
 */
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'agentmemory-mcp-plugin', version: '1.0.0' };

export class McpError extends Error {
    constructor(message, { code = 'MCP_ERROR', detail = null } = {}) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * One MCP server connection over stdio.
 *
 * Failure posture: every public method rejects with `McpError` rather than
 * throwing a raw Error, so a caller can put the reason in front of a user or
 * the model without leaking a stack trace into a tool result.
 */
export class StdioMcpClient {
    #child = null;
    #nextId = 1;
    /** id -> { resolve, reject, timer } */
    #pending = new Map();
    #buffer = '';
    #closing = false;
    #stderr = '';

    constructor({ command, args = [], env = {}, cwd = null, name = 'mcp', timeoutMs = 60_000, debug = null }) {
        this.command = command;
        this.args = args;
        this.env = env;
        this.cwd = cwd;
        this.name = name;
        this.timeoutMs = timeoutMs;
        this.debug = typeof debug === 'function' ? debug : null;
        this.serverInfo = null;
        this.tools = [];
        this.protocolVersion = null;
    }

    /** The child's recent stderr, for a readable startup/call failure. */
    get stderrTail() {
        return this.#stderr.trim();
    }

    /** True while the child process is alive and nothing closed the client. */
    get connected() {
        return this.#child !== null && !this.#closing;
    }

    #log(message) {
        if (this.debug) {
            try {
                this.debug(message);
            } catch {
                /* logging must never decide anything */
            }
        }
    }

    /** Spawn the server and complete the MCP handshake. */
    async connect() {
        if (this.#child) return this;

        let child;
        try {
            child = spawn(this.command, this.args, {
                cwd: this.cwd || undefined,
                // The parent env is inherited *on purpose*: the MCP server needs
                // PATH/HOME to run, and the caller already decided which secrets
                // to add. This is a local process the user configured, not a
                // model-authored command.
                env: { ...process.env, ...this.env },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            throw new McpError(`cannot start MCP server "${this.name}": ${error.message}`, { code: 'SPAWN_FAILED' });
        }
        this.#child = child;

        child.on('error', (error) => {
            this.#failAll(new McpError(`MCP server "${this.name}" failed: ${error.message}`, { code: 'SPAWN_FAILED' }));
        });
        child.on('exit', (code, signal) => {
            this.#child = null;
            const tail = this.stderrTail.split('\n').slice(-3).join(' | ');
            this.#failAll(
                new McpError(
                    `MCP server "${this.name}" exited (code=${code} signal=${signal})${tail ? `: ${tail}` : ''}`,
                    { code: 'SERVER_EXITED' },
                ),
            );
        });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.#onData(chunk));

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            // Bounded: a chatty server must not grow memory without limit.
            this.#stderr = (this.#stderr + chunk).slice(-4096);
            this.#log(`stderr: ${String(chunk).trim().slice(0, 300)}`);
        });

        const init = await this.#request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        this.serverInfo = init?.serverInfo ?? null;
        this.protocolVersion = init?.protocolVersion ?? PROTOCOL_VERSION;
        this.#notify('notifications/initialized', {});

        const listed = await this.#request('tools/list', {});
        this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
        this.#log(`connected: ${this.name} (${this.tools.length} tools)`);
        return this;
    }

    /**
     * Call one tool. Returns the raw MCP `result` object.
     *
     * `signal` comes from the tool execution (`exec.signal`): the registry does
     * not abandon a started body, so without it a cancelled turn waits out the
     * full `timeoutMs`. On abort the pending request is dropped, the server is
     * told via `notifications/cancelled`, and the promise rejects with
     * `CANCELLED`.
     */
    async callTool(name, args, signal) {
        if (!this.#child) {
            throw new McpError(`MCP server "${this.name}" is not connected`, { code: 'NOT_CONNECTED' });
        }
        return this.#request('tools/call', { name, arguments: args ?? {} }, { signal });
    }

    async close() {
        this.#closing = true;
        const child = this.#child;
        this.#child = null;
        this.#failAll(new McpError(`MCP server "${this.name}" closed`, { code: 'CLOSED' }));
        if (!child) return;
        try {
            child.stdin.end();
        } catch {
            /* already gone */
        }
        // SIGTERM, then SIGKILL: a wedged child must not outlive the session.
        const killTimer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        }, 2_000);
        killTimer.unref?.();
        try {
            child.kill('SIGTERM');
        } catch {
            /* already gone */
        }
    }

    #onData(chunk) {
        this.#buffer += chunk;
        let newline;
        while ((newline = this.#buffer.indexOf('\n')) !== -1) {
            const line = this.#buffer.slice(0, newline).trim();
            this.#buffer = this.#buffer.slice(newline + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                // A server that prints a banner to stdout is common enough that
                // treating it as fatal would make the plugin unusable.
                this.#log(`non-JSON line ignored: ${line.slice(0, 200)}`);
                continue;
            }
            this.#route(message);
        }
        // A server that never terminates a line must not grow the buffer forever.
        if (this.#buffer.length > 8 * 1024 * 1024) {
            this.#buffer = '';
            this.#log('dropped an oversized partial frame');
        }
    }

    #route(message) {
        if (message && typeof message.id !== 'undefined' && this.#pending.has(message.id)) {
            const entry = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                entry.reject(
                    new McpError(`${this.name}: ${message.error.message ?? 'request failed'}`, {
                        code: message.error.code ?? 'RPC_ERROR',
                        detail: message.error,
                    }),
                );
            } else {
                entry.resolve(message.result);
            }
            return;
        }
        // Server-initiated request (sampling/roots): answer permissively so the
        // server does not block, but never claim a capability we do not have.
        if (message && typeof message.method === 'string' && typeof message.id !== 'undefined') {
            this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not supported' } });
        }
    }

    #write(payload) {
        const child = this.#child;
        if (!child) return false;
        try {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    #notify(method, params) {
        this.#write({ jsonrpc: '2.0', method, params });
    }

    #request(method, params, { signal = null } = {}) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new McpError(`${this.name}: ${method} cancelled before dispatch`, { code: 'CANCELLED' }));
                return;
            }
            const settle = (fn) => {
                signal?.removeEventListener?.('abort', onAbort);
                fn();
            };
            const onAbort = () => {
                if (!this.#pending.has(id)) return;
                this.#pending.delete(id);
                clearTimeout(timer);
                // MCP 2025-06-18: tell the server the request is dead, so it can
                // stop working instead of computing into a closed pipe.
                this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'client cancelled' } });
                settle(() => reject(new McpError(`${this.name}: ${method} cancelled`, { code: 'CANCELLED' })));
            };
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                settle(() =>
                    reject(new McpError(`${this.name}: ${method} timed out after ${this.timeoutMs}ms`, { code: 'TIMEOUT' })),
                );
            }, this.timeoutMs);
            timer.unref?.();
            this.#pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject, timer });
            signal?.addEventListener?.('abort', onAbort, { once: true });
            if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
                this.#pending.delete(id);
                clearTimeout(timer);
                settle(() => reject(new McpError(`${this.name}: cannot write to the MCP server`, { code: 'WRITE_FAILED' })));
            }
        });
    }

    #failAll(error) {
        for (const [, entry] of this.#pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.#pending.clear();
    }
}

/** Flatten an MCP tool result's content array into displayable text. */
export function resultText(result) {
    if (!result) return '';
    const content = Array.isArray(result.content) ? result.content : [];
    const parts = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
        else if (item.type === 'resource' && typeof item.resource?.text === 'string') parts.push(item.resource.text);
        else if (item.type === 'image') parts.push(`[image${item.mimeType ? ` ${item.mimeType}` : ''}]`);
        else parts.push(`[${item.type ?? 'content'}]`);
    }
    if (parts.length === 0 && result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
    return parts.join('\n');
}
