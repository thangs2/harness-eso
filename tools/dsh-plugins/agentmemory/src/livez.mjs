/**
 * Liveness probe for an AgentMemory server.
 *
 * Why probe at all when the MCP shim already probes: the shim probes *lazily*,
 * on the first tool call, and when the probe fails it silently switches to a
 * reduced LOCAL FALLBACK — 7 of the 8 tools, writing to
 * `~/.agentmemory/standalone.json`, which is **shared by every repo**. Measured
 * on this machine: after the servers were down, that file held memories from
 * several repos at once. A repo quietly remembering into another repo's store is
 * the exact failure this plugin exists to prevent, so the plugin checks the
 * server itself, per agent, and registers nothing when the configured server is
 * not actually answering. `AGENTMEMORY_FORCE_PROXY=1` (set by the plugin) is the
 * second line of defence: if the server dies after the handshake, calls fail
 * loudly instead of falling back.
 *
 * The endpoint is the shim's own health check: `GET <base>/agentmemory/livez`
 * → `{"service":"agentmemory","status":"ok"}` (measured 2026-11-07 on :3111,
 * :3211, :3311).
 */

const LIVEZ_PATH = '/agentmemory/livez';
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * @param {string} url - normalized base URL of the server.
 * @param {{ secret?: string|null, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string, body?: unknown }>}
 */
export async function probeLivez(url, options = {}) {
    const base = String(url).replace(/\/+$/, '');
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const headers = options.secret ? { authorization: `Bearer ${options.secret}` } : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        const response = await fetchImpl(`${base}${LIVEZ_PATH}`, {
            method: 'GET',
            headers,
            redirect: 'error',
            signal: controller.signal,
        });
        if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
        /*
         * A 200 is not enough: an unrelated server that happens to answer this
         * path (dev server, proxy error page, port reuse) must not be mounted as
         * this repo's memory store. Require the shim's own health payload —
         * measured 2026-11-07: {"service":"agentmemory","status":"ok"}.
         */
        let body;
        try {
            body = await response.json();
        } catch {
            return { ok: false, status: response.status, reason: 'livez did not return JSON' };
        }
        if (!body || typeof body !== 'object') {
            return { ok: false, status: response.status, reason: 'livez returned no object payload' };
        }
        if (typeof body.service === 'string' && body.service !== 'agentmemory') {
            return { ok: false, status: response.status, reason: `unexpected service "${body.service}"` };
        }
        if (typeof body.status === 'string' && body.status !== 'ok') {
            return { ok: false, status: response.status, reason: `status "${body.status}"` };
        }
        if (body.service !== 'agentmemory' && body.status !== 'ok') {
            return {
                ok: false,
                status: response.status,
                reason: `unexpected livez payload (service=${String(body.service)}, status=${String(body.status)})`,
            };
        }
        return { ok: true, status: response.status, body };
    } catch (error) {
        const reason =
            error?.name === 'AbortError' || error?.name === 'TimeoutError'
                ? `timed out after ${timeoutMs}ms`
                : error?.cause?.code ?? error?.message ?? String(error);
        return { ok: false, reason };
    } finally {
        clearTimeout(timer);
    }
}
