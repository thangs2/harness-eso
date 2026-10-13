import { loadTypesafeKeyFromRepo } from './jev-state-builder.mjs';

export function resolveTypesafeApiKey(policy, cfg) {
    const mode = policy?.jev?.mode ?? 'off';
    if (mode === 'off') return null;
    const key = process.env.TYPESAFE_API_KEY || loadTypesafeKeyFromRepo(cfg);
    if (!key || String(key).includes('your_key_here')) return null;
    return key;
}

/**
 * @param {{ model: string, state: string, questions: object }} body
 * @param {{ policy: object, cfg?: object, apiKey?: string, fetchImpl?: typeof fetch }} opts
 */
export async function postSystemOne(body, opts = {}) {
    const policy = opts.policy || {};
    const mode = policy.jev?.mode ?? 'off';
    if (mode === 'off') {
        return { ok: true, status: 0, skipped: true };
    }

    const apiKey = opts.apiKey ?? resolveTypesafeApiKey(policy, opts.cfg);
    if (!apiKey) {
        return { ok: false, status: 0, error: 'no_typesafe_api_key', skipped: true };
    }

    const base = String(policy.jev?.baseUrl || process.env.TYPESAFE_API_BASE || 'https://api.typesafe.ai').replace(
        /\/$/,
        '',
    );
    const timeoutMs = policy.jev?.timeoutMs ?? 8000;
    const fetchFn = opts.fetchImpl ?? globalThis.fetch;
    if (!fetchFn) {
        return { ok: false, status: 0, error: 'fetch_unavailable' };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
        const res = await fetchFn(`${base}/v1/systemone`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: body.model || policy.jev?.model || 'jev-latest',
                state: body.state,
                questions: body.questions,
            }),
            signal: controller?.signal,
        });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = { raw: text };
        }
        if (!res.ok) {
            return { ok: false, status: res.status, json, error: `http_${res.status}` };
        }
        return { ok: true, status: res.status, json };
    } catch (err) {
        const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || 'fetch_failed';
        return { ok: false, status: 0, error: msg };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
