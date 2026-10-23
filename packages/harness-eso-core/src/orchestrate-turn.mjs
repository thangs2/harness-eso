import { decide } from '@mu/harness-decision';
import { findRepoRoot, isoNow } from '@mu/harness-foundation/pure';
import { runCollect } from './collect.mjs';
import { buildTurnVerdict } from './gate.mjs';
import { loadEsoPolicy, declaredSources, resolveEsoPolicy } from './eso-policy.mjs';
import { loadHarnessProfile } from './profile-load.mjs';

/**
 * DPEF v2 — Collect → Gate (Act is host-side).
 * @param {object} event
 * @param {{ phase?: 'preflight' | 'full', cfg?: object, policy?: object, profileId?: string, decideFn?: typeof decide, waiver?: object, injectSnippets?: object[], reads?: object, registry?: object, blockers?: object[] }} [options]
 *   `blockers` are host-supplied hard blockers; the engine does not run the checks itself, because
 *   they read files and a preflight runs on every turn.
 */
export async function orchestrateTurn(event, options = {}) {
    const phase = options.phase ?? 'preflight';
    if (process.env.HARNESS_ESO === '0' && !options.policy) {
        return { skipped: true, reason: 'eso_disabled' };
    }

    const profileLoad = options.policy
        ? { policy: options.policy }
        : loadHarnessProfile(options.profileId ?? 'generic-eso', options.cfg);
    const policy = profileLoad.policy;
    const eso = resolveEsoPolicy(policy);
    /*
     * The sources block is decided **here**, once, for both callers (G-01). The host pack knows whether
     * the consumer's file named `sources` (it reads that file before the loader merges defaults into it)
     * and says so with `sourcesDeclared`; an ingest run does not, and trusts the merged block as written.
     */
    eso.sources = declaredSources(policy?.eso?.sources, {
        declared: policy?.eso?.sourcesDeclared === true ? true : policy?.eso?.sourcesDeclared === false ? false : undefined,
    });

    if (!eso.enabled) {
        return { skipped: true, reason: 'eso_disabled' };
    }
    if (phase === 'preflight' && eso.preflight?.enabled === false) {
        return { skipped: true, reason: 'preflight_disabled' };
    }

    const requestId = event.turnId || event.requestId || event.sessionId || 'unknown';
    const stem = String(event.userQueryStem || '').trim();
    const root = options.cfg?.root || findRepoRoot() || process.cwd();
    const decideFn = options.decideFn || decide;

    const facade = await decideFn(
        { ...event, event: event.event ?? 'turn_start' },
        { ...options, policy, writeLedger: false },
    );

    const surface = { bucket: facade.route?.bucket ?? facade.l0?.winner?.bucket ?? 'general' };
    const collected = await runCollect(event, {
        policy,
        eso,
        surface,
        stem,
        root,
        conversationId: event.conversationId ?? options.conversationId,
        reads: options.reads,
        injectSnippets: options.injectSnippets,
        registry: options.registry,
    });

    const verdict = buildTurnVerdict({
        requestId,
        phase,
        measure: collected.measure,
        gaps: collected.gaps,
        eso,
        stem,
        waiver: options.waiver,
        blockers: options.blockers ?? [],
    });

    return {
        skipped: false,
        at: isoNow(),
        phase,
        facade,
        pack: collected.pack,
        retrieval: collected.retrieval,
        gaps: collected.gaps,
        measure: collected.measure,
        lawMisses: collected.lawMisses,
        verdict,
    };
}

export { loadEsoPolicy };
