/**
 * DSH plugin logic (RFC 18 M2).
 *
 * This is the part that can be tested without a running Harness: it owns the host's provider set and
 * exposes the two operations the Cordis `apply(ctx, config)` wrapper will call —
 * `preflight(event)` and `probe()`.
 *
 * The wrapper itself is deliberately not here yet. Cordis' `apply` needs a real `ctx` (agent events,
 * tool guards); inventing that surface before DSH exposes it would produce code that compiles against
 * a guess. What lands now is the seam, so the wrapper is a thin translation and nothing else.
 */
import fs from 'node:fs';
import { createHostRuntime } from '@mu/harness-eso-core';
import { createDshSessionMemory } from './memory-provider.mjs';
import { createDshSkillsLaw } from './law-provider.mjs';

/**
 * @param {{
 *   root: string,
 *   policy: object,
 *   searchEvents?: Function,
 *   providers?: object[],
 *   memoryId?: string,
 * }} options
 */
export function createDshEsoPlugin(options = {}) {
    const { root, policy, searchEvents, providers = [], memoryId = 'native:dsh-session' } = options;
    if (!policy) throw new Error('createDshEsoPlugin: policy is required');

    const all = [...providers];
    if (typeof searchEvents === 'function') {
        all.push(createDshSessionMemory({ searchEvents, id: memoryId }));
    }
    /*
     * The host's own skills are always available, so registering them costs nothing until a policy
     * chain prefers native law. Registering is not selecting: the default law path still resolves to
     * the first capable provider, which is docgraph.
     */
    if (options.law !== false && root && fs.existsSync(root)) {
        all.push(createDshSkillsLaw({ root, maxSnippets: options.lawSnippets }));
    }
    const runtime = createHostRuntime({ root, policy, providers: all });

    return {
        name: 'harness-eso',
        runtime,
        probe: () => runtime.probe(),
        preflight: (event, overrides) => runtime.preflight(event, overrides),
    };
}
