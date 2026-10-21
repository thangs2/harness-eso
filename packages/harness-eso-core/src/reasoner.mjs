/**
 * Reasoner port (RFC 18 §3.2) — expensive reasoning behind a binding, not a hard-coded model.
 *
 * The engine never calls a model itself. It asks a provider to delegate a task and returns whatever
 * the host allowed. That keeps the paid path (an external model) and the free path (the host's own
 * subagent/model) interchangeable, and makes the budget explicit: a paid provider is not called once
 * the per-turn pool is spent, and the caller gets `degraded: true` instead of a silent fallback.
 */

export const REASONER_FALLBACK = 'none';

function chainFor(policy) {
    const reasoner = policy?.eso?.reasoner ?? {};
    const chain = [];
    for (const entry of [...(reasoner.prefer ?? []), ...(reasoner.fallback ?? [])]) {
        if (typeof entry === 'string' && entry) chain.push(entry);
    }
    if (!chain.length && typeof reasoner.adapter === 'string' && reasoner.adapter) chain.push(reasoner.adapter);
    return chain;
}

function pick(policy, providers, budget) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const chain = chainFor(policy);
    const candidates = chain.length ? chain.map((id) => byId.get(id)).filter(Boolean) : providers;
    for (const provider of candidates) {
        if (!Array.isArray(provider.kinds) || !provider.kinds.includes('reasoner')) continue;
        try {
            if (typeof provider.healthCheck === 'function' && !provider.healthCheck(policy)) continue;
        } catch {
            continue;
        }
        if (provider.paid === true && Number.isFinite(budget.remainingUsd) && budget.remainingUsd <= 0) continue;
        return provider;
    }
    return null;
}

/**
 * @param {{
 *   task: { prompt: string, [key: string]: unknown },
 *   policy: object,
 *   providers?: object[],
 *   budget?: { remainingUsd?: number },
 * }} input
 */
export async function delegateReasoning(input) {
    const { task, policy, providers = [], budget = {} } = input;
    if (!task || typeof task.prompt !== 'string' || !task.prompt.trim()) {
        throw new Error('delegateReasoning: task.prompt is required');
    }

    const provider = pick(policy, providers, budget);
    if (!provider) {
        return { ok: false, provider: null, text: null, degraded: true, reason: 'no_provider_or_budget' };
    }
    try {
        const answer = await provider.delegate(task, { policy, budget });
        return {
            ok: true,
            provider: provider.id,
            text: typeof answer?.text === 'string' ? answer.text : '',
            usage: answer?.usage ?? null,
            paid: provider.paid === true,
            degraded: false,
            reason: null,
        };
    } catch (err) {
        return { ok: false, provider: provider.id, text: null, degraded: true, reason: `reasoner_error:${err?.message ?? err}` };
    }
}

/** Host-native reasoner: the DSH subagent / the host's own model. Free from the engine's point of view. */
export function createHostReasoner({ delegate, id = 'native:host-model' } = {}) {
    if (typeof delegate !== 'function') throw new Error('createHostReasoner: delegate must be a function');
    return {
        id,
        kinds: ['reasoner'],
        capability: 'native',
        paid: false,
        async delegate(task, ctx) {
            return delegate(task, ctx);
        },
    };
}

/** External paid reasoner (DeepSeek or any transport the caller supplies). */
export function createExternalReasoner({ delegate, id = 'deepseek-mcp', costUsd = 0 } = {}) {
    if (typeof delegate !== 'function') throw new Error('createExternalReasoner: delegate must be a function');
    return {
        id,
        kinds: ['reasoner'],
        capability: 'external',
        paid: true,
        costUsd,
        async delegate(task, ctx) {
            return delegate(task, ctx);
        },
    };
}
