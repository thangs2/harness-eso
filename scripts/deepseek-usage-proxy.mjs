#!/usr/bin/env node
/**
 * Local measuring proxy in front of the DeepSeek API — the only way to see the real token cost of a
 * Cursor **custom (own-key) model**.
 *
 * Why this exists: the harness `stop` hook reports `input_tokens` / `cache_read_tokens` for Cursor's
 * own models, but for a custom model Cursor sends no usage at all — `request_stop` gets a row with
 * every token column NULL (`node scripts/token-audit.mjs` prints these under "audit blind spot").
 * The provider still knows the truth, though, and it returns it in every response. So: put this in
 * front of the provider, point the custom model's base URL at it, and the numbers fall out.
 *
 * What one record answers:
 *   - `prompt_tokens` per call        → how big the context really got (compare with the window)
 *   - `cacheHitRate`                  → is prefix caching actually being used, or is the whole
 *                                       context billed at full input price every single call?
 *   - `toolsChars` / `toolsCount`     → how much of that context is MCP tool schemas, i.e. the
 *                                       fixed overhead you pay on *every* call of the loop
 *   - calls per prompt                → group by minute to see the agent loop's multiplier
 *
 * Streaming: DeepSeek only reports `usage` on a stream when the request asks for
 * `stream_options.include_usage`, which Cursor does not set. The proxy adds it, and swallows the
 * extra trailing chunk from the client's point of view (OpenAI-compatible clients ignore it).
 * Pass `--no-force-usage` to forward the body untouched.
 *
 * Dev tool only — it never runs as part of the product and holds no state beyond the log file.
 *
 * Privacy: the log records sizes and token counts, never message content or the Authorization
 * header. The credential Cursor sends is forwarded verbatim and not stored.
 *
 * Usage
 *   node scripts/deepseek-usage-proxy.mjs
 *   # Cursor → Settings → Models → custom OpenAI model → base URL: http://127.0.0.1:8787/v1
 *   tail -f ~/.harness/deepseek-proxy-usage.jsonl
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
    const out = {
        port: 8787,
        upstream: 'https://api.deepseek.com',
        log: path.join(os.homedir(), '.harness', 'deepseek-proxy-usage.jsonl'),
        envFile: process.env.DEEPSEEK_ENV_FILE || path.join(os.homedir(), '.gemini', 'antigravity', 'deepseek.env'),
        forceUsage: true,
        ca: process.env.DEEPSEEK_CA_FILE || null,
        insecure: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--port') out.port = Number(argv[++i]);
        else if (a === '--upstream') out.upstream = argv[++i].replace(/\/$/, '');
        else if (a === '--log') out.log = argv[++i];
        else if (a === '--env-file') out.envFile = argv[++i];
        else if (a === '--no-force-usage') out.forceUsage = false;
        else if (a === '--ca') out.ca = argv[++i];
        else if (a === '--insecure') out.insecure = true;
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

/** `KEY=value` lines from a dotenv-style file. Only used for the API key. */
function loadEnvFile(file) {
    if (!file || !fs.existsSync(file)) return {};
    const env = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return env;
}

function measureBody(raw) {
    const info = { model: null, stream: false, messageCount: 0, messagesChars: 0, systemChars: 0, toolsCount: 0, toolsChars: 0 };
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return { info, body: null };
    }
    info.model = body?.model ?? null;
    info.stream = body?.stream === true;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    info.messageCount = messages.length;
    for (const m of messages) {
        const chars = JSON.stringify(m).length;
        info.messagesChars += chars;
        if (m?.role === 'system') info.systemChars += chars;
    }
    if (Array.isArray(body?.tools)) {
        info.toolsCount = body.tools.length;
        info.toolsChars = JSON.stringify(body.tools).length;
    }
    return { info, body };
}

/** Pull `usage` out of either a plain JSON response or the last SSE `data:` chunk. */
function usageFrom(text, stream) {
    if (!stream) {
        try {
            return JSON.parse(text)?.usage ?? null;
        } catch {
            return null;
        }
    }
    let found = null;
    for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const u = JSON.parse(payload)?.usage;
            if (u) found = u;
        } catch {
            /* partial frame, ignore */
        }
    }
    return found;
}

const args = parseArgs(process.argv);
if (args.help) {
    console.log('usage: node scripts/deepseek-usage-proxy.mjs [--port 8787] [--upstream URL] [--log FILE]');
    console.log('       node scripts/deepseek-usage-proxy.mjs --summary [--log FILE]');
    process.exit(0);
}

/**
 * `--summary`: read the log the proxy wrote and answer the cost questions directly.
 * This is the whole point of the tool, so it should not need `jq` and a bespoke pipeline.
 */
if (process.argv.includes('--summary')) {
    if (!fs.existsSync(args.log)) {
        console.error(`No log at ${args.log} — run the proxy and send a prompt through it first.`);
        process.exit(1);
    }
    const all = fs
        .readFileSync(args.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    // Drop port-scanner / DevTools probes so they cannot distort the totals.
    const rows = all.filter((r) => /\/chat\/completions|\/completions/.test(r.path ?? ''));
    const skipped = all.length - rows.length;

    const n = (v) => Number(v ?? 0);
    const prompt = rows.reduce((a, r) => a + n(r.prompt_tokens), 0);
    const cacheHit = rows.reduce((a, r) => a + n(r.prompt_cache_hit_tokens), 0);
    const completion = rows.reduce((a, r) => a + n(r.completion_tokens), 0);
    const reasoning = rows.reduce((a, r) => a + n(r.reasoning_tokens), 0);
    const toolChars = rows.reduce((a, r) => a + n(r.toolsChars), 0);
    const ctxs = rows.map((r) => n(r.prompt_tokens)).filter(Boolean);

    console.log(`calls logged: ${rows.length}${skipped ? `  (ignored ${skipped} non-model request${skipped === 1 ? '' : 's'})` : ''}`);
    if (!rows.length) {
        console.log();
        console.log('No model calls yet — Cursor has not sent a completion through the proxy.');
        console.log('Check: base URL is http://127.0.0.1:<port>/v1, and the chat was opened AFTER the change.');
        process.exit(0);
    }
    console.log(`prompt tokens (total across calls): ${prompt.toLocaleString('en-US')}`);
    console.log(`completion tokens: ${completion.toLocaleString('en-US')}  (reasoning: ${reasoning.toLocaleString('en-US')})`);
    console.log(
        `cache hit: ${cacheHit.toLocaleString('en-US')} (${prompt ? ((cacheHit / prompt) * 100).toFixed(1) : '—'}%)  ` +
            `→ miss billed full price: ${(prompt - cacheHit).toLocaleString('en-US')}`,
    );
    if (ctxs.length) {
        console.log(`context per call: min ${Math.min(...ctxs).toLocaleString('en-US')}  ` +
            `max ${Math.max(...ctxs).toLocaleString('en-US')}  ` +
            `avg ${Math.round(ctxs.reduce((a, b) => a + b, 0) / ctxs.length).toLocaleString('en-US')}`);
    }
    const perCallTools = rows.filter((r) => n(r.toolsCount) > 0);
    if (perCallTools.length) {
        const avgTools = Math.round(perCallTools.reduce((a, r) => a + n(r.toolsChars), 0) / perCallTools.length);
        console.log(
            `tool schemas: ${perCallTools[0].toolsCount} tools, ~${avgTools.toLocaleString('en-US')} chars ` +
                `(~${Math.round(avgTools / 3.6).toLocaleString('en-US')} tok) re-sent on every call`,
        );
    }
    console.log();
    console.log('calls per burst (a burst = calls within 120s of each other = one agent loop):');
    const bursts = [];
    let prev = null;
    for (const r of rows) {
        const t = Date.parse(r.at);
        if (prev == null || t - prev > 120_000) bursts.push({ start: r.at, calls: 0, prompt: 0, ctx: 0 });
        const b = bursts[bursts.length - 1];
        b.calls += 1;
        b.prompt += n(r.prompt_tokens);
        b.ctx = n(r.prompt_tokens);
        prev = t;
    }
    for (const [i, b] of bursts.entries()) {
        console.log(
            `  burst ${i + 1}: ${String(b.calls).padStart(3)} calls  ` +
                `${b.prompt.toLocaleString('en-US').padStart(12)} prompt tok  last ctx ${b.ctx.toLocaleString('en-US')}`,
        );
    }
    console.log(`  → ${bursts.length} burst(s) / ${rows.length} calls  (avg ${(rows.length / bursts.length).toFixed(1)} calls per prompt)`);
    console.log('  Bảo vệ: burst nào > 20 call là "marathon" — chi phí của nó ≈ bậc hai theo số call.');
    process.exit(0);
}

// The API key is NOT required. Cursor already sends its own `Authorization` header for the custom
// model, and this proxy passes it straight through — so the key never has to be copied into a second
// place. The env/file lookup is only a fallback for clients that do not send one.
const envFromFile = loadEnvFile(args.envFile);
const fallbackKey = process.env.DEEPSEEK_API_KEY || envFromFile.DEEPSEEK_API_KEY || null;

fs.mkdirSync(path.dirname(args.log), { recursive: true });
const upstreamUrl = new URL(args.upstream);
const transport = upstreamUrl.protocol === 'https:' ? https : http;

/**
 * TLS trust for the upstream. Node carries its own CA list and does not read the macOS keychain, so
 * a cert that `curl` accepts can still fail here with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Resolve it
 * without weakening anything globally:
 *   --ca FILE     trust an explicit bundle (e.g. /etc/ssl/cert.pem, or a corporate root)
 *   --insecure    last resort, prints a warning
 */
const tlsOptions = {};
if (args.insecure) {
    tlsOptions.rejectUnauthorized = false;
} else if (args.ca) {
    if (!fs.existsSync(args.ca)) {
        console.error(`--ca file not found: ${args.ca}`);
        process.exit(1);
    }
    tlsOptions.ca = fs.readFileSync(args.ca);
}

const totals = { calls: 0, prompt_tokens: 0, cache_hit: 0, completion: 0, toolsChars: 0 };

function record(rec) {
    fs.appendFileSync(args.log, `${JSON.stringify(rec)}\n`);
    totals.calls += 1;
    totals.prompt_tokens += Number(rec.prompt_tokens ?? 0);
    totals.cache_hit += Number(rec.prompt_cache_hit_tokens ?? 0);
    totals.completion += Number(rec.completion_tokens ?? 0);
    totals.toolsChars += Number(rec.toolsChars ?? 0);
    const hit = rec.prompt_tokens ? `${((rec.cacheHitRate ?? 0) * 100).toFixed(0)}% cached` : 'no usage';
    // Non-chat traffic is noise: port scanners and Chrome DevTools auto-discovery (`/json/version`)
    // hit any listening socket on localhost. Tag it so it is never mistaken for a stalled model call.
    const isModelCall = /\/chat\/completions|\/completions/.test(rec.path ?? '');
    if (!isModelCall) {
        console.log(`#${totals.calls} (not a model call) ${rec.path} → HTTP ${rec.httpStatus}`);
        return;
    }
    console.log(
        `#${totals.calls} ${rec.model ?? '?'}  prompt=${rec.prompt_tokens ?? '?'}  ${hit}  ` +
            `tools=${rec.toolsCount}(${rec.toolsChars}B)  msgs=${rec.messageCount}(${rec.messagesChars}B)  ` +
            `HTTP ${rec.httpStatus}  ${rec.elapsedMs}ms`,
    );
    if (totals.calls % 10 === 0) {
        const rate = totals.prompt_tokens ? ((totals.cache_hit / totals.prompt_tokens) * 100).toFixed(1) : '—';
        console.log(
            `  ── running: ${totals.calls} calls, prompt_total=${totals.prompt_tokens.toLocaleString('en-US')}, ` +
                `cached=${rate}%, tools_chars_total=${totals.toolsChars.toLocaleString('en-US')}`,
        );
    }
}

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        let raw = Buffer.concat(chunks);
        const { info, body } = measureBody(raw.toString('utf8'));
        if (body && info.stream && args.forceUsage) {
            body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
            raw = Buffer.from(JSON.stringify(body));
        }

        const headers = { ...req.headers, host: upstreamUrl.host, 'content-length': String(raw.length) };
        // Prefer the caller's own credential (Cursor's custom-model key) over any local fallback.
        if (!headers.authorization && fallbackKey) headers.authorization = `Bearer ${fallbackKey}`;
        delete headers['accept-encoding']; // keep the body readable for usage parsing

        const started = Date.now();
        const upstreamReq = transport.request(
            {
                protocol: upstreamUrl.protocol,
                hostname: upstreamUrl.hostname,
                port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
                path: `${upstreamUrl.pathname.replace(/\/$/, '')}${req.url}`,
                method: req.method,
                headers,
                ...tlsOptions,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
                let captured = '';
                upstreamRes.on('data', (chunk) => {
                    res.write(chunk);
                    captured += chunk.toString('utf8');
                });
                upstreamRes.on('end', () => {
                    res.end();
                    const usage = usageFrom(captured, info.stream) ?? {};
                    const prompt = Number(usage.prompt_tokens ?? 0);
                    record({
                        at: new Date().toISOString(),
                        path: req.url,
                        model: info.model,
                        stream: info.stream,
                        messageCount: info.messageCount,
                        messagesChars: info.messagesChars,
                        systemChars: info.systemChars,
                        toolsCount: info.toolsCount,
                        toolsChars: info.toolsChars,
                        prompt_tokens: usage.prompt_tokens ?? null,
                        completion_tokens: usage.completion_tokens ?? null,
                        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
                        prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? null,
                        prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? null,
                        cacheHitRate: prompt ? Number((usage.prompt_cache_hit_tokens ?? 0) / prompt) : null,
                        elapsedMs: Date.now() - started,
                        httpStatus: upstreamRes.statusCode ?? null,
                    });
                });
            },
        );

        upstreamReq.on('error', (err) => {
            console.error(`upstream error: ${err.message}`);
            if (/local issuer|certificate|self.signed|UNABLE_TO_GET_ISSUER/i.test(err.message)) {
                console.error(
                    '  → TLS trust problem: Node does not read the macOS keychain. Retry with one of:\n' +
                        '      node scripts/deepseek-usage-proxy.mjs --ca /etc/ssl/cert.pem\n' +
                        '      node --use-system-ca scripts/deepseek-usage-proxy.mjs\n' +
                        '      node scripts/deepseek-usage-proxy.mjs --insecure   (only if the two above fail)',
                );
            }
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
        });
        req.on('aborted', () => upstreamReq.destroy());
        upstreamReq.end(raw);
    });
});

server.listen(args.port, '127.0.0.1', () => {
    console.log(`deepseek usage proxy → ${args.upstream}`);
    console.log(`listening on http://127.0.0.1:${args.port}   log: ${args.log}`);
    console.log(`auth: passthrough (cursor's own key)${fallbackKey ? ' + local fallback' : ''}`);
    console.log(`point the Cursor custom model base URL at http://127.0.0.1:${args.port}/v1`);
    void preflight();
});

/**
 * Prove the upstream is reachable *before* a prompt depends on it.
 *
 * A TLS failure otherwise surfaces only as `upstream error` after the user has already sent a
 * prompt, with no usage recorded — the exact dead end this script exists to remove. A 401/200 is a
 * pass: it means DNS, TCP and TLS all work, and the only thing missing is a key.
 */
async function preflight() {
    const probe = (opts) =>
        new Promise((resolve) => {
            const u = new URL(args.upstream);
            const req = transport.request(
                { ...opts, protocol: u.protocol, hostname: u.hostname, port: u.port || 443, path: '/v1/models', method: 'GET' },
                (res) => {
                    res.resume();
                    resolve({ ok: true, status: res.statusCode });
                },
            );
            req.setTimeout(8000, () => req.destroy(new Error('timeout')));
            req.on('error', (err) => resolve({ ok: false, code: err.code || '', message: err.message }));
            req.end();
        });

    if (args.insecure) {
        const r = await probe(tlsOptions);
        console.log(r.ok ? `  preflight: reachable (HTTP ${r.status}, TLS verification OFF)` : `  preflight: FAILED — ${r.message}`);
        return;
    }

    const first = await probe(tlsOptions);
    if (first.ok) {
        console.log(`  preflight: reachable (HTTP ${first.status})`);
        return;
    }
    if (/local issuer|certificate|self.signed|UNABLE_TO_GET_ISSUER/i.test(first.message || '')) {
        for (const candidate of ['/etc/ssl/cert.pem', '/usr/local/etc/openssl/cert.pem', '/opt/homebrew/etc/openssl@3/cert.pem']) {
            if (!fs.existsSync(candidate) || args.ca === candidate) continue;
            const r = await probe({ ...tlsOptions, ca: fs.readFileSync(candidate) });
            if (r.ok) {
                console.log(`  preflight: reachable via system CA bundle (HTTP ${r.status})`);
                console.log(`  ⚠ restart with: node scripts/deepseek-usage-proxy.mjs --ca ${candidate}`);
                console.log('    (traffic will fail until you do — this run has no working trust store)');
                return;
            }
        }
        console.log(`  preflight: FAILED — TLS trust (${first.message})`);
        console.log('  fix: --ca /etc/ssl/cert.pem   |   --use-system-ca   |   --insecure');
        return;
    }
    console.log(`  preflight: FAILED — ${first.message}`);
}
