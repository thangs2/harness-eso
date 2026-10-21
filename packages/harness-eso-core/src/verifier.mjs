/**
 * Verifier port (RFC 18 §4) — a decision oracle behind a binding, not a global switch.
 *
 * The old shape was `jev.mode`, one value for the whole process. That cannot express the two things a
 * real deployment needs: a cheap claim (`ROUTE`) may run in `shadow` while a dangerous one (`GUARD`)
 * runs `active`, and a paid verifier must be budgeted against the same pool as the reasoner.
 *
 * This module is the engine half. It knows nothing about TypeSafe: a provider is any object with
 * `verify(claim, ctx)`. The JEV adapter below is one implementation, and `host-policy` is not a
 * provider at all — it is the verdict the caller already reached, which is why falling back can never
 * invent an answer the host did not give.
 */

export const VERIFIER_CLAIMS = ['ROUTE', 'GUARD'];
export const VERIFIER_MODES = ['off', 'shadow', 'active'];

function normaliseMode(value) {
    return VERIFIER_MODES.includes(value) ? value : null;
}

/**
 * Mode for one claim: `eso.verifier.modes[claim]` wins, then `eso.verifier.mode`, then off.
 * @returns {'off'|'shadow'|'active'}
 */
export function resolveVerifierMode(policy, claim) {
    const verifier = policy?.eso?.verifier ?? {};
    return normaliseMode(verifier.modes?.[claim]) ?? normaliseMode(verifier.mode) ?? 'off';
}

function chainFor(policy) {
    const verifier = policy?.eso?.verifier ?? {};
    const chain = [];
    for (const entry of [...(verifier.prefer ?? []), ...(verifier.fallback ?? [])]) {
        if (typeof entry === 'string' && entry) chain.push(entry);
    }
    if (!chain.length && typeof verifier.adapter === 'string' && verifier.adapter) chain.push(verifier.adapter);
    return chain;
}

function pickProvider(policy, claim, providers) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const chain = chainFor(policy);
    const candidates = chain.length ? chain.map((id) => byId.get(id)).filter(Boolean) : providers;

    for (const provider of candidates) {
        if (Array.isArray(provider.claims) && !provider.claims.includes(claim)) continue;
        try {
            if (typeof provider.healthCheck === 'function' && !provider.healthCheck(policy)) continue;
        } catch {
            continue;
        }
        return provider;
    }
    return null;
}

/**
 * @param {{
 *   claim: 'ROUTE'|'GUARD',
 *   hostVerdict: 'allow'|'deny'|'ask',
 *   policy: object,
 *   providers?: object[],
 *   budget?: { remainingPaidCalls?: number },
 *   context?: object,
 * }} input
 */
export async function verifyClaim(input) {
    const { claim, hostVerdict, policy, providers = [], budget = {}, context = {} } = input;
    if (!VERIFIER_CLAIMS.includes(claim)) throw new Error(`verifyClaim: unknown claim ${claim}`);

    const mode = resolveVerifierMode(policy, claim);
    const base = { claim, hostVerdict, mode, source: 'host-policy' };
    if (mode === 'off') return { ...base, verdict: hostVerdict, reason: 'verifier_off' };

    const provider = pickProvider(policy, claim, providers);
    if (!provider) return { ...base, verdict: hostVerdict, reason: 'no_provider' };

    const paid = provider.paid === true;
    if (paid && Number.isFinite(budget.remainingPaidCalls) && budget.remainingPaidCalls <= 0) {
        return { ...base, verdict: hostVerdict, reason: 'budget_exhausted', degraded: true };
    }

    let answer;
    try {
        answer = await provider.verify({ claim, hostVerdict, policy, context });
    } catch (err) {
        const onUnavailable = policy?.eso?.verifier?.onUnavailable ?? 'fallback';
        return {
            ...base,
            verdict: onUnavailable === 'deny' ? 'deny' : hostVerdict,
            reason: `verifier_error:${err?.message ?? err}`,
            degraded: true,
        };
    }

    const verdict = ['allow', 'deny', 'ask'].includes(answer?.verdict) ? answer.verdict : hostVerdict;
    const result = {
        ...base,
        verdict,
        source: provider.id,
        confidence: typeof answer?.confidence === 'number' ? answer.confidence : null,
        reason: answer?.reason ?? null,
        paid,
    };

    if (mode === 'shadow') {
        /*
         * Shadow is only useful if the disagreement is recorded. Returning the host verdict without
         * the diff would make the mode indistinguishable from `off` in the ledger.
         */
        return {
            ...result,
            verdict: hostVerdict,
            shadowDiff: { host: hostVerdict, verifier: verdict, agree: verdict === hostVerdict },
        };
    }
    return result;
}

/**
 * Adapter for a JEV-style answer. `callJev` owns the HTTP transport (and its budget); this wrapper
 * only normalises the contract and declares the provider's mode support.
 *
 * @param {{ callJev: (claim: object) => Promise<object>, id?: string, ceiling?: number }} options
 */
export function createJevVerifier(options = {}) {
    const { callJev, id = 'typesafe-jev', ceiling = 0.9 } = options;
    if (typeof callJev !== 'function') throw new Error('createJevVerifier: callJev must be a function');
    return {
        id,
        kinds: ['verifier'],
        capability: 'external',
        claims: [...VERIFIER_CLAIMS],
        modes: ['shadow', 'active'],
        paid: true,
        ceiling,
        async verify(claim) {
            const answer = await callJev(claim);
            return {
                verdict: answer?.verdict,
                confidence: answer?.confidence,
                reason: answer?.reason ?? null,
            };
        },
    };
}
