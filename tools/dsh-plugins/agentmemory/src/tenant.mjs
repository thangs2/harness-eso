/**
 * Workspace → AgentMemory server resolution.
 *
 * The problem this solves: one DSH profile serves many repos, and each repo runs
 * its own agentmemory container on its own host port — x79 :3111, baplatform
 * :3211, FinESO :3311 on this machine. A static `cordis.patch.yml` row cannot
 * express that: the Loader composes rows once at boot, before any session or
 * working directory exists, and `!!js` evaluates against the loader context,
 * which has no session cwd. So the decision has to happen per agent creation, in
 * code.
 *
 * Resolution order for a workspace root (first hit wins):
 *   1. `<root>/.dsh/agentmemory.json`      — explicit, per repo, commit-safe when
 *                                            it holds only a URL and a credential
 *                                            *name*, never the secret
 *   2. `<root>/.cursor/mcp.json`           — what Cursor already uses in this repo
 *   3. `<root>/.agents/mcp_config.json`    — what Antigravity uses in this repo
 *   4. inherited config from a parent dir  — a monorepo root serves its packages
 *   5. null                                — no AgentMemory here, register nothing
 *
 * Only `AGENTMEMORY_URL` decides *which* server; the MCP shim speaks stdio, so a
 * repo cannot point the plugin at an arbitrary HTTP MCP endpoint here.
 *
 * The secret is never read from these files when a credential name is present: it
 * is resolved through `ctx.credentials` so the secret lives in
 * `$DSH_HOME/.credentials.yaml` (owner-only), not in a repo file. A loopback URL
 * with no explicit secret needs none — the shim reads `~/.agentmemory/secret`
 * itself, and the servers on this machine answer without auth (measured
 * 2026-11-07: `GET /agentmemory/livez` → 200, `memory_smart_search` succeeds).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';

/** Env keys the plugin owns; a repo config may set every other `AGENTMEMORY_*` key. */
const CONTROLLED_ENV = new Set([
    'AGENTMEMORY_URL',
    'AGENTMEMORY_VIEWER_URL',
    'AGENTMEMORY_SECRET',
    'AGENTMEMORY_FORCE_PROXY',
    'AGENTMEMORY_AGENT_SCOPE',
    'AGENTMEMORY_CREDENTIAL_MODE',
]);

const MAX_PARENT_DEPTH = 6;

/**
 * Read JSON. Missing file → null; unreadable/invalid file → `{ __broken }`.
 *
 * The distinction matters: continuing past a broken repo config can silently
 * inherit a *parent* directory's server, which is another repo's store. That is
 * the class of bug this plugin exists to prevent, so a broken config stops
 * resolution instead of being skipped.
 */
function readJson(path) {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        return { __broken: error.message ?? String(error) };
    }
}

/**
 * Normalize an AgentMemory endpoint to a base URL.
 *
 * Accepts `http://localhost:3211`, `localhost:3211`, `http://localhost:3211/`
 * and a deployment under a sub-path. The shim itself rejects a URL with
 * credentials, a query or a fragment (measured in its `baseUrl()`), so this
 * rejects them too instead of spawning a server that starts and then fails.
 */
export function normalizeUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    // A scheme that is not http(s) is a config error, not a hostname to prefix.
    // `localhost:3211` is a host:port, not a `localhost:` scheme — only a real
    // `scheme://` counts as a scheme here.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const url = new URL(withScheme);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (!url.hostname) return null;
        if (url.username || url.password) return null;
        if (url.search || url.hash) return null;
        const path = url.pathname.replace(/\/+$/, '');
        return `${url.protocol}//${url.host}${path}`;
    } catch {
        return null;
    }
}

/** `localhost`, `127.0.0.0/8` or `::1` — where the shim may read its local secret. */
export function isLoopbackUrl(value) {
    const url = normalizeUrl(value);
    if (!url) return false;
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** A stable, log-safe label for a target: `localhost:3211`, never the secret. */
export function labelFor(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.host}${path}`;
    } catch {
        return url;
    }
}

/** The credential key a hosted endpoint maps to: `AGENTMEMORY_SECRET_MEMORY_EXAMPLE_COM`. */
export function credentialNameFor(url, explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    // Loopback stores carry their secret next to their data or in ~/.agentmemory;
    // deriving a store key there would only produce a misleading "expected" line.
    if (isLoopbackUrl(normalized)) return null;
    const label = new URL(normalized).hostname.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
    return `AGENTMEMORY_SECRET_${label}`;
}

/** Everything a repo config may say about one server, in one internal shape. */
function buildTarget({ url, viewerUrl, secretRef, inlineSecret, agentScope, credentialMode, extraEnv, source }) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const viewer = viewerUrl ? normalizeUrl(viewerUrl) : null;
    return {
        url: normalized,
        viewerUrl: viewer,
        label: labelFor(normalized),
        secretRef: credentialNameFor(normalized, secretRef),
        inlineSecret: typeof inlineSecret === 'string' && inlineSecret.trim() ? inlineSecret.trim() : null,
        agentScope: agentScope === 'isolated' || agentScope === 'shared' ? agentScope : null,
        credentialMode: credentialMode === 'explicit' ? 'explicit' : null,
        extraEnv,
        source,
    };
}

/** Copy only the `AGENTMEMORY_*` keys the plugin does not itself control. */
function collectExtraEnv(env) {
    const extra = {};
    if (!env || typeof env !== 'object') return extra;
    for (const [key, value] of Object.entries(env)) {
        if (!/^AGENTMEMORY_/.test(key)) continue;
        if (CONTROLLED_ENV.has(key)) continue;
        if (typeof value === 'string' && value.trim()) extra[key] = value.trim();
        else if (typeof value === 'number' || typeof value === 'boolean') extra[key] = String(value);
    }
    return extra;
}

/** `<root>/.dsh/agentmemory.json` — the explicit per-repo dialect. */
function fromDshConfig(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    return buildTarget({
        url: raw.url ?? raw.serverUrl ?? raw.endpoint ?? raw.baseUrl,
        viewerUrl: raw.viewerUrl ?? raw.viewer,
        secretRef: raw.credential ?? raw.credentialRef ?? raw.secretRef,
        inlineSecret: raw.secret,
        agentScope: raw.agentScope,
        credentialMode: raw.credentialMode,
        extraEnv: collectExtraEnv(raw.env),
        source,
    });
}

/**
 * `.cursor/mcp.json` / `.agents/mcp_config.json` — the MCP client dialect.
 *
 * Picks the entry literally named `agentmemory` or `agentmemory-mcp` (both are in
 * use across the repos on this machine), else the first entry whose env carries
 * `AGENTMEMORY_URL`. `command`/`args` from the repo are deliberately ignored:
 * the same shim is spawned from this plugin's own config, so a repo cannot turn
 * an agent session into an arbitrary process launch.
 */
function fromMcpConfig(raw, source) {
    const servers = raw?.mcpServers ?? raw?.mcp_servers;
    if (!servers || typeof servers !== 'object') return null;
    const entries = Object.entries(servers).filter(([, value]) => value && typeof value === 'object');
    const chosen =
        entries.find(([key]) => /^agentmemory(-mcp)?$/i.test(key)) ??
        entries.find(([, value]) => Boolean(value.env?.AGENTMEMORY_URL));
    if (!chosen) return null;
    const env = chosen[1].env ?? {};
    return buildTarget({
        url: env.AGENTMEMORY_URL,
        viewerUrl: env.AGENTMEMORY_VIEWER_URL,
        secretRef: env.AGENTMEMORY_CREDENTIAL,
        inlineSecret: env.AGENTMEMORY_SECRET,
        agentScope: env.AGENTMEMORY_AGENT_SCOPE,
        credentialMode: env.AGENTMEMORY_CREDENTIAL_MODE,
        extraEnv: collectExtraEnv(env),
        source,
    });
}

/** Candidate config files in one directory, in priority order. */
function candidatesIn(root) {
    return [
        { path: join(root, '.dsh', 'agentmemory.json'), read: fromDshConfig },
        { path: join(root, '.cursor', 'mcp.json'), read: fromMcpConfig },
        { path: join(root, '.agents', 'mcp_config.json'), read: fromMcpConfig },
    ];
}

/**
 * Resolve the AgentMemory target for a workspace root.
 *
 * @param {string} workspaceRoot - absolute session working directory.
 * @param {{ globalDefault?: object }} [options]
 * @returns {object|null|{ broken: { path: string, message: string } }} target descriptor,
 *   null when this repo has no AgentMemory, or a `broken` marker when a config
 *   file exists but cannot be parsed (resolution stops there on purpose).
 */
export function resolveTarget(workspaceRoot, options = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/')) return null;

    let dir = resolvePath(workspaceRoot);
    for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
        for (const candidate of candidatesIn(dir)) {
            const raw = readJson(candidate.path);
            if (!raw) continue;
            if (raw.__broken) return { broken: { path: candidate.path, message: raw.__broken } };
            const target = candidate.read(raw, candidate.path);
            if (target) return target;
        }
        const parent = dirname(dir);
        if (parent === dir || parent === '/') break;
        dir = parent;
    }

    // A profile-wide default, when the operator configured one.
    return options.globalDefault ? fromDshConfig({ ...options.globalDefault, __source: 'profile' }, 'profile') : null;
}

/**
 * The credentials service, read without declaring it in `inject`.
 *
 * Cordis service proxies throw when they are not injected, but a plugin that
 * cannot resolve a secret should still register tools for a loopback server that
 * needs none. `ctx.get(name)` reads an optional service; the direct property is
 * the fallback for contexts that expose it plainly (and for the test shim).
 */
function credentialsOf(ctx) {
    try {
        const viaGet = ctx?.get?.('credentials');
        if (viaGet) return viaGet;
    } catch {
        /* not mounted here */
    }
    try {
        return ctx?.credentials ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolve the shared secret for a target.
 *
 * Order: an explicit credential from the DSH store (owner-only file) → the secret
 * the repo's own MCP config already carries → the ambient environment → none.
 * "None" is a normal state: a loopback server usually needs no secret, and the
 * shim reads `~/.agentmemory/secret` itself. It is not a startup failure.
 */
export async function resolveSecret(ctx, target) {
    /*
     * The reason is per-call, not module state: two agents can resolve against
     * different targets concurrently, and a stale failure from one must never be
     * reported as the cause for another.
     */
    let reason = null;
    const credentials = credentialsOf(ctx);
    if (target.secretRef && typeof credentials?.resolve === 'function') {
        try {
            const hit = await credentials.resolve(target.secretRef);
            if (hit && typeof hit.value === 'string' && hit.value) {
                return { secret: hit.value, from: `credentials:${target.secretRef}(${hit.source ?? 'file'})` };
            }
            reason = `credential "${target.secretRef}" not found in the DSH store`;
        } catch (error) {
            reason = `credential "${target.secretRef}" failed: ${error?.message ?? String(error)}`;
        }
    }
    if (target.inlineSecret) return { secret: target.inlineSecret, from: target.source };
    const env = process.env[target.secretRef ?? ''] ?? process.env.AGENTMEMORY_SECRET;
    if (typeof env === 'string' && env.trim()) return { secret: env.trim(), from: 'environment' };
    return { secret: null, from: null, reason };
}
