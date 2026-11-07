/**
 * AgentMemory MCP for DSH — one plugin, one memory server per workspace.
 *
 * The requirement is the same one `@local/jira-mcp-plugin` answers: one DSH
 * profile serves many repos, each owning its own AgentMemory instance — on this
 * machine x79 :3111, baplatform :3211, FinESO :3311. A static `cordis.patch.yml`
 * row cannot express that (the Loader composes rows once at boot, before any
 * session or working directory exists), so the target is decided here, per
 * `agent/created`, and a stdio MCP shim is spawned for that workspace only.
 *
 * Constraints this file obeys, each learned from the installed Harness:
 *  - No `@deepseek-ai/*` import: a host plugin that imports the Harness runtime
 *    can hoist a second copy of a singleton into the profile (the sibling Jira
 *    plugin records this as ATF-OPS-001 and `@mu/harness-eso-dsh` ships a
 *    zero-dependency bundle for the same reason). The `TOOL_RUNTIME_SCHEDULER`
 *    symbol those notes cite no longer exists in 0.2.2-rc.1, so this is kept as
 *    a dependency-freedom rule rather than as a measured claim.
 *  - Every Cordis service this plugin reads is declared in `inject`.
 *    `ctx.workingDirectory` / `ctx.agents` are **proxies that throw**
 *    `cannot get property "…" without inject`, and a `try/catch` that swallows
 *    that turns the plugin into a silent no-op — measured 2026-11-07 on
 *    DSH 0.2.2-rc.1: `inject: ['tools']` alone made every agent register 0 tools
 *    with no log line. Optional services are read through `ctx.get(name)`.
 *  - Tools are registered on `agent.ctx`, not the plugin ctx, so they disappear
 *    when that agent is disposed. Per the Harness contract an `agent/created`
 *    listener must return only after its tool installation completes, so the
 *    server handshake is awaited here. That costs one MCP startup per new agent
 *    (~0.7 s through a warm `npx`, ~46 ms through a direct `node` entrypoint,
 *    measured 2026-11-07) and buys a deterministic tool list.
 *  - A workspace with no AgentMemory config registers nothing, silently. The
 *    plugin never blocks or slows a repo it was not configured for.
 *  - A configured workspace whose server is not answering registers nothing
 *    either, and says why: the shim's local fallback writes to a single
 *    per-user store shared by every repo, so "mount tools and hope" would mix
 *    tenants. `AGENTMEMORY_FORCE_PROXY=1` keeps a server that dies *after* the
 *    handshake from falling back too.
 */
import { appendFileSync } from 'node:fs';

import { StdioMcpClient, resultText } from './mcp-stdio-client.mjs';
import { probeLivez } from './livez.mjs';
import { resolveSecret, resolveTarget } from './tenant.mjs';

export const name = 'agentmemory-mcp-plugin';

/**
 * Services this plugin reads. `workingDirectory` is required to resolve the repo;
 * `agents` is read through `ctx.get` because bootstrap is best-effort.
 */
export const inject = ['tools', 'workingDirectory'];

export const DEFAULT_SERVER = { command: 'npx', args: ['-y', '@agentmemory/mcp'] };
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_TOOL_PREFIX = '';

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]`, at most 64 characters. */
const MAX_TOOL_NAME_LENGTH = 64;

/** Absolute POSIX path or nothing. Shared by every directory source below. */
const isAbsoluteDir = (value) => typeof value === 'string' && value.startsWith('/');

/**
 * Headless hosts route `logger.info` away from the terminal. `AGENTMEMORY_PLUGIN_DEBUG=1`
 * mirrors the plugin's diagnostics to stderr, and `AGENTMEMORY_PLUGIN_DEBUG_FILE`
 * appends them to a file, so a "no tools appeared" session can be explained
 * without reinstalling a debug build.
 */
function debug(message) {
    if (process.env.AGENTMEMORY_PLUGIN_DEBUG !== '1') return;
    const line = `[agentmemory-mcp-plugin] ${message}\n`;
    try {
        process.stderr.write(line);
    } catch {
        /* diagnostics must never decide anything */
    }
    try {
        const path = process.env.AGENTMEMORY_PLUGIN_DEBUG_FILE;
        if (path) appendFileSync(path, line);
    } catch {
        /* diagnostics must never decide anything */
    }
}

/**
 * MCP tool name → a model-facing description.
 *
 * The server's own descriptions are short and generic; these state the working
 * agreement (search before work, distill before saving, never save raw
 * transcripts) without changing the tool surface.
 */
const DESCRIPTION_OVERRIDES = {
    memory_smart_search:
        "Search this repository's AgentMemory store (hybrid semantic + keyword). Call it at the start of work that continues an earlier session, and again before asking the user to repeat context. Prefer a bounded query.",
    memory_recall:
        'Search past session observations of this repository for relevant context. Use when you need what happened in previous sessions rather than a saved insight.',
    memory_save:
        "Save one durable insight, decision, bug, pattern or preference to this repository's AgentMemory. Write the distilled conclusion plus why, not a transcript; include the files involved. Confirm with the user before saving anything sensitive.",
    memory_sessions: 'List recent agent sessions for this repository with their status and observation counts.',
    memory_consolidate:
        'Run the memory consolidation pipeline (working → episodic → semantic → procedural). Expensive; run only when the user asks.',
    memory_diagnose: 'Run AgentMemory health checks across its subsystems. Use when memory reads look wrong or empty.',
    memory_lesson_save:
        'Save a lesson learned (a recommendation with confidence) from this session. Reinforce an existing lesson instead of duplicating it.',
    memory_reflect:
        'Traverse the knowledge graph, cluster related memories and synthesise higher-order insights. Expensive; run only when the user asks.',
};

/** Keep a configured prefix inside the function-name contract. */
function normalizePrefix(value) {
    if (typeof value !== 'string') return DEFAULT_TOOL_PREFIX;
    return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Apply the configured prefix, avoiding a doubled prefix and the 64-char ceiling. */
function toolNameFor(prefix, rawName) {
    const joined = (prefix && rawName.startsWith(prefix) ? rawName : `${prefix}${rawName}`).replace(
        /[^A-Za-z0-9_-]/g,
        '_',
    );
    return joined.length <= MAX_TOOL_NAME_LENGTH ? joined : joined.slice(0, MAX_TOOL_NAME_LENGTH);
}

/**
 * The environment the shim is spawned with.
 *
 * Exported so `src/selfcheck.mjs` and the tests use the same construction the
 * runtime uses — a second copy would drift and "selfcheck passed" would stop
 * meaning anything.
 */
export function buildServerEnv(target, secret, { insecureTls = false } = {}) {
    return {
        // Repo-provided extras first, so a repo cannot override the invariants
        // below (`FORCE_PROXY`, the resolved URL, the resolved secret).
        ...target.extraEnv,
        AGENTMEMORY_URL: target.url,
        /*
         * Measured hazard, not a preference: with the URL unreachable the shim
         * silently switches to a reduced local store at
         * `~/.agentmemory/standalone.json` — shared by every repo — and only 7 of
         * its 8 tools work. Forcing the proxy turns that into a loud per-call
         * error instead of cross-repo contamination.
         */
        AGENTMEMORY_FORCE_PROXY: '1',
        ...(target.viewerUrl ? { AGENTMEMORY_VIEWER_URL: target.viewerUrl } : {}),
        ...(target.agentScope ? { AGENTMEMORY_AGENT_SCOPE: target.agentScope } : {}),
        ...(secret ? { AGENTMEMORY_SECRET: secret } : {}),
        // When we hand the shim a secret from the DSH store, it must not go and
        // auto-read a different local secret file on top of it.
        ...(secret || target.credentialMode === 'explicit' ? { AGENTMEMORY_CREDENTIAL_MODE: 'explicit' } : {}),
        ...(insecureTls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
    };
}

/**
 * Build one tool definition from an MCP tool descriptor.
 *
 * `defineTool` from `dsh-tools` cannot be imported here, so this returns the same
 * registry-ready shape: a JSON Schema for `parameters`, an `output` with a
 * `render`, and an `execute` that resolves to the output value.
 */
function buildTool(client, descriptor, target, { prefix, timeoutMs }) {
    const schema =
        descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
            ? descriptor.inputSchema
            : { type: 'object', properties: {}, additionalProperties: false };

    return {
        name: toolNameFor(prefix, descriptor.name),
        description:
            DESCRIPTION_OVERRIDES[descriptor.name] ?? descriptor.description ?? `AgentMemory: ${descriptor.name}`,
        parameters: schema,
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    text: { type: 'string', description: 'Rendered AgentMemory response text.' },
                    isError: { type: 'boolean', description: 'True when AgentMemory reported a tool-level error.' },
                },
                required: ['text'],
            },
            render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
            presentationMeta: () => ({
                title: `AgentMemory · ${target.label}`,
                subtitle: descriptor.name,
            }),
        },
        timeoutMs,
        execute: async (args, exec) => {
            try {
                // The registry does not abandon a started body on cancel, so the
                // turn's signal has to reach the socket or a stopped call runs to
                // its full deadline.
                const result = await client.callTool(descriptor.name, args ?? {}, exec?.signal);
                const text = resultText(result);
                if (result?.isError) {
                    // Reported as a value, not a throw: the model needs to see the
                    // server's own message to correct its query.
                    return { text: text || 'AgentMemory returned an error with no message.', isError: true };
                }
                return { text };
            } catch (error) {
                /*
                 * A dead server produces a fetch/JSON-RPC error. Returning it as an
                 * isError value keeps the model in the loop (it can tell the user
                 * the memory server is down) instead of turning into a generic
                 * harness error that hides which repository's server failed.
                 */
                return { text: `AgentMemory MCP (${target.label}): ${error.message}`, isError: true };
            }
        },
    };
}

/**
 * Cordis/DSH plugin factory.
 *
 * @param {object} [defaults] - programmatic seam for tests; row `config` wins.
 */
export function createAgentMemoryPlugin(defaults = {}) {
    return {
        name,
        inject,
        apply(ctx, config = {}) {
            const log = (message) => {
                try {
                    ctx.logger?.info?.(`agentmemory-mcp-plugin: ${message}`);
                } catch {
                    /* logging must never decide anything */
                }
            };

            /** A startup failure the operator asked to be loud about. */
            const complain = (message) => {
                log(message);
                debug(message);
                if (!failOnStartupError) return;
                try {
                    ctx.logger?.error?.(`agentmemory-mcp-plugin: ${message}`);
                } catch {
                    /* logging must never decide anything */
                }
            };

            const serverCommand = config.serverCommand ?? defaults.serverCommand ?? DEFAULT_SERVER.command;
            const serverArgs = Array.isArray(config.serverArgs)
                ? config.serverArgs.map(String)
                : (defaults.serverArgs ?? DEFAULT_SERVER.args);
            const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
            const probeTimeoutMs = Number.isFinite(config.probeTimeoutMs)
                ? config.probeTimeoutMs
                : DEFAULT_PROBE_TIMEOUT_MS;
            const insecureTls = (config.insecureTls ?? defaults.insecureTls ?? false) === true;
            /*
             * `failOnStartupError` raises a startup failure from `info` to `error`.
             * It deliberately does NOT throw: a throwing `agent/created` listener
             * rejects agent registration, so throwing here would take down every
             * session in a repo with a dead memory server. A plugin never gets to
             * be that important.
             */
            const failOnStartupError = config.failOnStartupError === true;
            const globalDefault = config.default ?? defaults.default ?? null;
            const toolPrefix = normalizePrefix(config.toolPrefix ?? defaults.toolPrefix ?? DEFAULT_TOOL_PREFIX);
            // Test seam only: a YAML row can neither express nor need a probe function.
            const probeImpl = config.probeImpl ?? defaults.probeImpl ?? probeLivez;

            /** agent → { client, disposers } so disposal can tear down the process. */
            const sessions = new Map();

            /**
             * The agent's effective project directory.
             *
             * `workingDirectory.get(session)` is a pure read of the committed
             * projection (falling back to the service default); `ensure(agent)`
             * additionally validates that the directory still exists. `ensure` is
             * preferred, `get` is the fallback for a Harness that predates it.
             */
            const currentDirOf = async (agent) => {
                const workingDirectory = ctx.workingDirectory;
                if (typeof workingDirectory?.ensure === 'function') {
                    try {
                        const dir = await workingDirectory.ensure(agent);
                        if (isAbsoluteDir(dir)) return dir;
                    } catch (error) {
                        debug(`workingDirectory.ensure failed: ${error.message}`);
                    }
                }
                try {
                    if (typeof workingDirectory?.get !== 'function') return null;
                    const dir = workingDirectory.get(agent.session);
                    return isAbsoluteDir(dir) ? dir : null;
                } catch (error) {
                    debug(`workingDirectory.get failed: ${error.message}`);
                    return null;
                }
            };

            const startFor = async (agent) => {
                const workspaceRoot = await currentDirOf(agent);
                debug(`start session=${agent?.session?.id ?? '?'} cwd=${workspaceRoot}`);
                if (!workspaceRoot) return null;

                const target = resolveTarget(workspaceRoot, { globalDefault });
                if (target?.broken) {
                    // Do not walk past an unreadable config: the next hit could be a
                    // parent repo's store, and writing there is cross-repo mixing.
                    complain(
                        `cannot parse AgentMemory config ${target.broken.path} (${target.broken.message}). ` +
                            `Resolution stopped there; no tools for workspace ${workspaceRoot}.`,
                    );
                    return null;
                }
                debug(`target=${target ? target.url : 'none'} (${workspaceRoot})`);
                if (!target) return null; // this repo has no AgentMemory: register nothing

                const { secret, from, reason } = await resolveSecret(ctx, target);

                /*
                 * Probe before mounting, always. The shim would otherwise mount its
                 * local fallback (a per-user store shared by every repo), and with
                 * FORCE_PROXY=1 a dead URL makes its own handshake fail — so "mount
                 * anyway" has no useful state to offer. No server, no tools, and a
                 * log line that names the URL and the reason.
                 */
                const probe = await probeImpl(target.url, { secret, timeoutMs: probeTimeoutMs });
                debug(`probe=${probe?.ok ? 'ok' : `fail(${probe?.reason ?? probe?.status ?? '?'})`}`);
                if (!probe?.ok) {
                    complain(
                        `no AgentMemory server answering at ${target.url} for workspace ${workspaceRoot} ` +
                            `(${probe?.reason ?? probe?.status ?? 'no response'}${reason ? `; credential: ${reason}` : ''}). ` +
                            `Start its container (installation/agentmemory); tools not registered for this session.`,
                    );
                    return null;
                }

                const client = new StdioMcpClient({
                    command: serverCommand,
                    args: serverArgs,
                    env: buildServerEnv(target, secret, { insecureTls }),
                    cwd: workspaceRoot,
                    name: `agentmemory:${target.label}`,
                    timeoutMs,
                    debug: (message) => log(`${target.label} ${message}`),
                });

                try {
                    await client.connect();
                } catch (error) {
                    const tail = client.stderrTail;
                    client.close();
                    complain(
                        `connect failed for ${target.label}${tail ? ` (${tail.split('\n').slice(-2).join(' | ')})` : ''}: ${error.message}`,
                    );
                    return null;
                }

                const disposers = [];
                for (const descriptor of client.tools) {
                    try {
                        const definition = buildTool(client, descriptor, target, {
                            // Tool deadlines sit above the transport deadline on
                            // purpose: the transport's own timeout becomes an
                            // actionable tool result, not a generic runtime error.
                            prefix: toolPrefix,
                            timeoutMs: timeoutMs + 5_000,
                        });
                        const dispose = agent.ctx.tools.register(definition);
                        if (typeof dispose === 'function') disposers.push(dispose);
                    } catch (error) {
                        log(`cannot register ${descriptor?.name}: ${error.message}`);
                    }
                }

                log(
                    `registered ${disposers.length} tools for ${target.label} ` +
                        `(${target.url}, secret ${secret ? `from ${from}` : (reason ?? 'from shim store or none')}, ` +
                        `cwd ${workspaceRoot})`,
                );
                return { client, disposers, target };
            };

            /*
             * The event payload is NOT the agent. `dsh-agent` announces with
             * `ctx.serial(carrier, 'agent/created', { agent, source, …signal })` and
             * emits `{ agent }` on disposal, and Cordis' `dispatch()` shifts the
             * `this` carrier and the event name off the argument list before calling
             * a listener — so listeners receive the payload object, which every
             * shipped consumer destructures (`ctx.on('agent/created', ({ agent }) => …)`).
             *
             * Reading `agent.session` off the payload gives `undefined`, the
             * working-directory lookup swallows the failure, and the plugin
             * registers zero tools with zero log lines — the silent no-op the Jira
             * plugin shipped and fixed (measured 2026-10-29).
             */
            const agentOf = (payload, event) => {
                const agent = payload?.agent;
                // A truthy non-object would pass a plain falsy check, then throw
                // inside `WeakSet.add` — outside the install try/catch — and
                // reject the awaited `agent/created` listener, killing agent
                // registration. The contract is an object or nothing.
                if (typeof agent !== 'object' || agent === null) {
                    log(`${event} arrived without an agent payload; ignoring`);
                    return null;
                }
                return agent;
            };

            /** Agents disposed while their session was still being installed. */
            const disposedEarly = new WeakSet();
            /** Agents whose installation is in flight, so a bootstrap and an event cannot race. */
            const installing = new WeakSet();

            const teardown = (entry) => {
                for (const dispose of entry.disposers) {
                    try {
                        dispose();
                    } catch {
                        /* already gone */
                    }
                }
                void entry.client.close();
            };

            const installFor = async (agent, origin) => {
                if (!agent || sessions.has(agent) || installing.has(agent)) return;
                installing.add(agent);
                debug(`install ${origin} session=${agent?.session?.id ?? '?'}`);
                let entry = null;
                try {
                    entry = await startFor(agent);
                } catch (error) {
                    log(`${origin} failed: ${error.message}`);
                    return;
                } finally {
                    installing.delete(agent);
                }
                if (!entry) return;
                // The agent may have been disposed while the handshake was in flight:
                // storing the entry then would leak a process nothing can reach.
                if (disposedEarly.has(agent)) {
                    teardown(entry);
                    return;
                }
                sessions.set(agent, entry);
            };

            // One listener, wrapped so a failure here cannot break agent creation.
            const offCreated = ctx.on('agent/created', async (payload) => {
                await installFor(agentOf(payload, 'agent/created'), 'agent/created');
            });

            const offDisposed = ctx.on('agent/disposed', (payload) => {
                const agent = agentOf(payload, 'agent/disposed');
                if (!agent) return;
                disposedEarly.add(agent);
                const entry = sessions.get(agent);
                if (!entry) return;
                sessions.delete(agent);
                teardown(entry);
            });

            /*
             * Agents that already exist when this plugin activates never emit
             * `agent/created`: a plugin-manager enable or an HMR reload would leave
             * every live session AgentMemory-less for the rest of its life. Seed
             * them, without blocking activation on a handshake.
             *
             * `agents` is read through `ctx.get` rather than declared in `inject`:
             * bootstrap is best-effort, and a host without the service must still
             * get the `agent/created` path.
             */
            void (async () => {
                let existing = [];
                try {
                    const agents = ctx.get?.('agents');
                    existing = typeof agents?.list === 'function' ? agents.list() : [];
                } catch (error) {
                    log(`cannot list live agents: ${error.message}`);
                    return;
                }
                for (const agent of existing) {
                    await installFor(agent, 'agent bootstrap');
                }
            })();

            // Plugin unload must not leave MCP processes behind, even if the host
            // never emits a matching `agent/disposed` for a live agent.
            ctx.effect(() => () => {
                for (const [, entry] of sessions) teardown(entry);
                sessions.clear();
                offCreated?.();
                offDisposed?.();
            });
        },
    };
}

export default createAgentMemoryPlugin();
