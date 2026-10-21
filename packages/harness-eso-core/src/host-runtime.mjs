/**
 * Host runtime — the seam a host shim (DSH, Paseo, a test) uses to talk to the engine.
 *
 * The shim owns host concerns (which providers exist, how a prompt reaches the agent). The engine
 * owns collect/gate. Without this seam every shim would have to re-assemble the registry and remember
 * to forward it into `orchestrateTurn`; forgetting the last part silently drops the host's native
 * provider, which is exactly the failure this module prevents.
 */
import { createSourceRegistry } from './adapter-registry.mjs';
import { probeCapabilities } from './capability-probe.mjs';
import { orchestrateTurn } from './orchestrate-turn.mjs';

/**
 * @param {{
 *   root: string,
 *   policy: object,
 *   providers?: object[],
 *   health?: (provider: object, kind: string) => boolean,
 * }} options
 */
export function createHostRuntime(options = {}) {
    const { root, policy, providers = [], health } = options;
    if (!policy) throw new Error('createHostRuntime: policy is required');
    const registry = createSourceRegistry(policy, providers, health ? { health } : {});

    return {
        registry,
        probe() {
            return probeCapabilities(registry);
        },
        /**
         * Run ESO preflight with this host's providers bound.
         * @param {object} event the facade event (`{ event: 'turn_start', userQueryStem, turnId }`)
         * @param {object} [overrides] forwarded to orchestrateTurn (phase, reads, waiver…)
         */
        preflight(event, overrides = {}) {
            return orchestrateTurn(event, {
                ...overrides,
                policy,
                registry,
                cfg: overrides.cfg ?? (root ? { root } : undefined),
            });
        },
    };
}
