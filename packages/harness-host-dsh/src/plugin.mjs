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
import {
    createHostRuntime,
    hardBlockersFromChecks,
    loadCheckInputs,
    resolveEsoPolicy,
    withHardBlockers,
} from '@mu/harness-eso-core';
import { createDshSessionMemory } from './memory-provider.mjs';
import { createDshSkillsLaw } from './law-provider.mjs';

/**
 * @param {{
 *   root: string,
 *   policy: object,
 *   searchEvents?: Function,
 *   providers?: object[],
 *   memoryId?: string,
 *   checks?: { contract?: object, tenant?: object, migration?: object },
 * }} options
 */
export function createDshEsoPlugin(options = {}) {
    const { root, policy, searchEvents, providers = [], memoryId = 'native:dsh-session', checks = null } = options;
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
    /*
     * Checks may also come from the consumer's policy (`eso.checks`), so a host shim does not have to
     * be the place a project's paths are configured. An explicit option still wins: it is the more
     * specific declaration.
     */
    const declaredChecks = checks ?? resolveEsoPolicy(policy).checks;

    /**
     * Checks are declared as inputs (paths, tables), so the same call works from a hook bundle and
     * from a test. They run **before** the engine verdict, because the verdict has to carry the
     * blockers: a write guard that decides after the verdict was built decides too late.
     *
     * A skipped preflight stays skipped: blockers on a disabled engine would be a decision the
     * consumer never asked for.
     */
    async function preflight(event, overrides = {}) {
        const declared = overrides.checks ?? declaredChecks;
        let loaded = null;
        let blockers = [];
        if (declared) {
            loaded = loadCheckInputs(root ?? process.cwd(), declared);
            ({ blockers } = hardBlockersFromChecks(loaded));
        }
        const result = await runtime.preflight(event, {
            ...overrides,
            ...(declared ? { blockers } : {}),
        });
        if (!declared || !result || result.skipped) return result;
        return withHardBlockers(result, blockers, loaded.errors);
    }

    return {
        name: 'harness-eso',
        runtime,
        probe: () => runtime.probe(),
        preflight,
    };
}
