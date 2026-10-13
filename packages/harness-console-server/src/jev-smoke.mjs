/**
 * Ephemeral TypeSafe smoke — key from request body or process env only; never persisted.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

export function resolveApiKey(bodyKey) {
    const fromBody = typeof bodyKey === 'string' ? bodyKey.trim() : '';
    if (fromBody) return fromBody;
    const fromEnv = (process.env.TYPESAFE_API_KEY || '').trim();
    return fromEnv || null;
}

export function looksLikeTypesafeKey(key) {
    return typeof key === 'string' && key.startsWith('apikey_') && key.length > 20;
}

export async function smokeTypesafe({ apiKey, baseUrl, model }) {
    const key = (apiKey || '').trim();
    if (!key) {
        return { ok: false, error: 'missing_api_key', message: 'TYPESAFE_API_KEY not set' };
    }
    const base = (baseUrl || process.env.TYPESAFE_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
    const modelId = model || process.env.TYPESAFE_MODEL || DEFAULT_MODEL;

    const modelsRes = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
    });
    const modelsText = await modelsRes.text();
    if (!modelsRes.ok) {
        return {
            ok: false,
            error: 'models_failed',
            message: `GET /v1/models ${modelsRes.status}`,
            detail: modelsText.slice(0, 400),
        };
    }

    const payload = {
        model: modelId,
        state: 'harness console smoke: does this need human sign-off before coding?',
        questions: {
            needs_human: {
                type: 'noul',
                instructions: 'Does this work require human acceptance before coding?',
            },
        },
    };
    const soRes = await fetch(`${base}/v1/systemone`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
    });
    const soText = await soRes.text();
    if (!soRes.ok) {
        return {
            ok: false,
            error: 'systemone_failed',
            message: `POST /v1/systemone ${soRes.status}`,
            detail: soText.slice(0, 400),
        };
    }

    return {
        ok: true,
        base,
        model: modelId,
        modelsOk: true,
        systemOneOk: true,
    };
}

/**
 * @param {string} consumerRoot absolute path to agent repo
 */
export function consumerTypesafeEnvConfigured(consumerRoot) {
    if (!consumerRoot || typeof consumerRoot !== 'string') {
        return { envFileExists: false, keyConfigured: false };
    }
    try {
        const envPath = path.join(consumerRoot, 'installation/typesafe/typesafe.env');
        if (!fs.existsSync(envPath)) {
            return { envFileExists: false, keyConfigured: false, envPath };
        }
        const raw = fs.readFileSync(envPath, 'utf8');
        const line = raw
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('TYPESAFE_API_KEY='));
        const val = line ? line.slice('TYPESAFE_API_KEY='.length).trim() : '';
        const keyConfigured =
            looksLikeTypesafeKey(val) && !val.includes('your_key') && !val.includes('example');
        return { envFileExists: true, keyConfigured, envPath };
    } catch {
        return { envFileExists: false, keyConfigured: false };
    }
}
