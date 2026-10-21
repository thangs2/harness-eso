/**
 * Cordis entry for the DSH shim — the translation layer only.
 *
 * **Status: experimental.** The DSH surface this touches (`apply(ctx, config)`, `ctx.on` waterfall,
 * `additionalContexts`) is taken from the installed 0.2.1 docs, but it has not been exercised against
 * a running Harness (no quota). The translation is small on purpose: everything that can be tested —
 * provider binding, preflight, the context block — lives in `plugin.mjs` and is tested there. If the
 * real signature differs, only this file changes.
 *
 * It registers exactly one listener: `agent/pre-step`. Guards are NOT re-implemented here; the host
 * bridge (`harness-eso-hooks` bundle) keeps running the pack's guards, which is one enforcement path
 * rather than two that can disagree.
 */
import { createDshEsoPlugin } from './plugin.mjs';

/** The text this plugin adds to the step. Empty when ESO has nothing to say. */
export function buildContextBlock(result) {
    if (!result || result.skipped) return '';
    const level = result.verdict?.sufficiency?.level ?? result.measure?.level ?? null;
    const score = result.verdict?.sufficiency?.score ?? result.measure?.score ?? null;
    if (!level) return '';
    const gaps = (result.gaps ?? []).map((gap) => gap.kind || gap.query).filter(Boolean);
    const evidence = (result.retrieval?.snippets ?? []).slice(0, 3).map((snippet) => snippet.text);
    /*
     * Do not add noise to a step that is already fine: a sufficient verdict with no gaps and no
     * evidence has nothing the model could act on, and an extra context line costs tokens on every
     * step of every turn.
     */
    if (level === 'sufficient' && !gaps.length && !evidence.length) return '';
    const parts = [`ESO preflight: ${level}${typeof score === 'number' ? ` (score ${score.toFixed(2)})` : ''}.`];
    if (gaps.length) parts.push(`Open gaps: ${gaps.join(', ')}.`);
    if (evidence.length) parts.push(`Evidence:\n${evidence.join('\n')}`);
    return parts.join(' ');
}

/**
 * @param {object} options forwarded to createDshEsoPlugin (root, policy, searchEvents, law…)
 */
export function createEsoCordisPlugin(options = {}) {
    return {
        name: 'harness-eso',
        inject: ['sessions'],
        apply(ctx, config = {}) {
            const plugin = createDshEsoPlugin({ ...options, ...(config.eso ?? {}) });
            const disposers = [];

            if (typeof ctx?.on === 'function') {
                const off = ctx.on('agent/pre-step', async (decision, next) => {
                    const proceed = typeof next === 'function' ? next : (value) => value;
                    const event = {
                        event: 'turn_start',
                        turnId: decision?.turnId ?? decision?.requestId ?? undefined,
                        userQueryStem: String(decision?.userQueryStem ?? decision?.prompt ?? '').slice(0, 240),
                    };
                    try {
                        const result = await plugin.preflight(event);
                        const block = buildContextBlock(result);
                        if (!block) return proceed(decision);
                        return proceed({
                            ...decision,
                            additionalContexts: [...(decision?.additionalContexts ?? []), block],
                        });
                    } catch {
                        /* A failing plugin must not end the turn (DSH: plugin failure ends the turn). */
                        return proceed(decision);
                    }
                });
                if (typeof off === 'function') disposers.push(off);
            }

            return () => {
                for (const dispose of disposers) {
                    try {
                        dispose();
                    } catch {
                        /* disposal must not throw */
                    }
                }
            };
        },
    };
}
