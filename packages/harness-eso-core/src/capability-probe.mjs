/**
 * Capability probe — "what will this consumer actually use, and why" (RFC 18 M3).
 *
 * The resolver answers one kind at a time and throws the rest away. When an operator asks why a turn
 * used docgraph instead of the host's native memory, the answer has to include the candidates that
 * were skipped and the reason the winner won. This is that report, as data, so the CLI and the
 * Console render the same thing.
 */

export const PROBE_KINDS = ['law', 'code', 'memory', 'verifier', 'reasoner'];

/**
 * @param {ReturnType<import('./adapter-registry.mjs').createSourceRegistry>} registry
 * @param {string[]} [kinds]
 */
export function probeCapabilities(registry, kinds = PROBE_KINDS) {
    return kinds.map((kind) => {
        const picked = registry.resolveWithReason(kind);
        /*
         * A host shim may re-register an id the builtins already ship (a native provider named like
         * an external one). The registry keeps both; the probe must show one row per id, with the
         * last registration winning, or the report contradicts itself.
         */
        const byId = new Map();
        for (const provider of registry.list()) {
            if (Array.isArray(provider.kinds) && provider.kinds.includes(kind)) byId.set(provider.id, provider);
        }
        const candidates = [...byId.values()]
            .map((provider) => ({
                id: provider.id,
                capability: provider.capability ?? 'external',
                ceiling: typeof provider.ceiling === 'number' ? provider.ceiling : null,
                selected: picked.adapter ? provider.id === picked.adapter.id : false,
            }));

        return {
            kind,
            selected: picked.adapter
                ? {
                      id: picked.adapter.id,
                      capability: picked.adapter.capability ?? 'external',
                      ceiling: typeof picked.adapter.ceiling === 'number' ? picked.adapter.ceiling : null,
                  }
                : null,
            reason: picked.reason,
            candidates,
        };
    });
}
