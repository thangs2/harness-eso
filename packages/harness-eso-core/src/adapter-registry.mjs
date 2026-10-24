import { adapter as docgraphLaw } from '../adapters/docgraph-law.mjs';
import { adapter as codegraphCode } from '../adapters/codegraph-code.mjs';
import { adapter as noopMemory } from '../adapters/noop-memory.mjs';
import { adapter as agentmemoryMemory } from '../adapters/agentmemory-memory.mjs';

const BUILTINS = [docgraphLaw, codegraphCode, noopMemory, agentmemoryMemory];

/**
 * Provider registry (RFC 18, P1).
 *
 * A source is no longer "the one adapter id in policy". It is a **chain**: a native host capability
 * first (when a host shim registered one), then external providers, then `none`. The chain is
 * declarative, so the same consumer runs `native-first` on DSH and `explicit` on a host with no
 * native retrieval without touching the engine.
 *
 * Backward compatibility is deliberate: a policy that still says
 * `sources.law.adapter = "docgraph-cli"` resolves exactly as before. The new fields are additive.
 *
 *   "sources": {
 *     "memory": {
 *       "prefer":   ["native", "agentmemory-mcp"],
 *       "fallback": ["none"],
 *       "enabled":  true
 *     }
 *   }
 *
 * A provider may declare:
 *   id, kinds, fetch(), enabled(policy)   — the old contract
 *   capability: 'native' | 'external' | 'noop'
 *   healthCheck(policy): boolean           — cheap liveness probe
 *   ceiling: 0..1                          — max confidence it can contribute (RFC 18 §3.5)
 */

function normalise(adapter) {
    return {
        ...adapter,
        capability: adapter.capability ?? 'external',
        ceiling: typeof adapter.ceiling === 'number' ? adapter.ceiling : null,
    };
}

/**
 * @param {object} policy
 * @param {object[]} [extra] providers registered by a host shim or a test
 * @param {{ health?: (provider: object, kind: string) => boolean }} [options]
 */
export function createSourceRegistry(policy, extra = [], options = {}) {
    const providers = [...BUILTINS, ...extra].map(normalise);
    const byId = new Map(providers.map((p) => [p.id, p]));
    const externallyHealthy = options.health ?? (() => true);

    function enabled(provider, kind) {
        if (!provider.kinds.includes(kind)) return false;
        try {
            if (typeof provider.enabled === 'function' && !provider.enabled(policy)) return false;
        } catch {
            return false;
        }
        try {
            if (typeof provider.healthCheck === 'function' && !provider.healthCheck(policy)) return false;
        } catch {
            return false;
        }
        try {
            return externallyHealthy(provider, kind) !== false;
        } catch {
            return false;
        }
    }

    /** @returns {Array<string | null | { native: true }>} */
    function chainFor(kind) {
        const src = policy?.eso?.sources?.[kind] ?? {};
        const prefer = Array.isArray(src.prefer) ? src.prefer : null;
        const fallback = Array.isArray(src.fallback) ? src.fallback : null;
        if (!prefer && !fallback) {
            // Legacy: one id, or the first capable builtin.
            return src.adapter ? [src.adapter] : [];
        }
        const chain = [];
        for (const entry of [...(prefer ?? []), ...(fallback ?? [])]) {
            if (entry === 'none') chain.push(null);
            else if (entry === 'native') chain.push({ native: true });
            else if (typeof entry === 'string' && entry) chain.push(entry);
        }
        return chain;
    }

    return {
        /** First usable provider for the kind, or null. */
        resolve(kind) {
            return this.resolveWithReason(kind).adapter;
        },

        /**
         * Every kind's election in one object: `{ law: {reason, providerId}, ... }`.
         *
         * `resolveWithReason` answers for one kind and is easy to call and then discard — which is
         * exactly what happened: the registry knew which provider answered and every caller threw it
         * away, so "the consumer elected native" was indistinguishable from "nothing was found".
         * A whole-policy snapshot is what a turn records, so the callers that record have one thing to
         * call and no reason to reach for the lossy one.
         *
         * @param {string[]} [kinds]
         */
        elections(kinds = ['law', 'code', 'memory']) {
            const out = {};
            for (const kind of kinds) {
                const { adapter, reason } = this.resolveWithReason(kind);
                // `providerId` is what the provider calls itself; `reason` says how it was chosen.
                // Both are kept because `id:docgraph-cli` and `native` are different claims: one names
                // a provider, the other names a *capability class* the policy asked for.
                out[kind] = { reason, providerId: adapter?.id ?? null };
            }
            return out;
        },

        /**
         * The same answer plus WHY, so a trace can say `native`, `id:docgraph-cli`, `none` or
         * `exhausted` instead of leaving an absent provider unexplained.
         */
        resolveWithReason(kind) {
            const src = policy?.eso?.sources?.[kind] ?? {};
            if (src?.enabled === false) return { adapter: null, reason: 'disabled' };

            const chain = chainFor(kind);
            if (!chain.length) {
                /*
                 * Implicit default: the first capable provider, EXCEPT one that requires an explicit
                 * choice. Memory is the case that matters — a consumer that never configured memory
                 * must not start probing agentmemory just because the registry learned about it.
                 */
                const first = providers.find((p) => !p.requireExplicit && enabled(p, kind));
                return { adapter: first ?? null, reason: first ? 'default' : 'none' };
            }

            for (const entry of chain) {
                if (entry === null) return { adapter: null, reason: 'none' };
                if (typeof entry === 'object' && entry.native) {
                    const native = providers.find((p) => p.capability === 'native' && enabled(p, kind));
                    if (native) return { adapter: native, reason: 'native' };
                    continue;
                }
                const provider = byId.get(entry);
                if (provider && enabled(provider, kind)) return { adapter: provider, reason: `id:${entry}` };
            }
            return { adapter: null, reason: 'exhausted' };
        },

        list() {
            return providers.filter((p) => {
                try {
                    return typeof p.enabled !== 'function' || p.enabled(policy);
                } catch {
                    return false;
                }
            });
        },
    };
}
