/**
 * Cordis entry for the DSH shim — the translation layer only.
 *
 * **Contract verified against the installed runtime (0.2.1-rc.2 `app.asar`), not against prose:**
 *
 *   - a plugin is `{ name, inject, apply(ctx) }`, registered by `ctx.plugin(...)`;
 *   - the hook is `ctx.on('agent/pre-step', (payload, next) => decision)`, where `payload` is
 *     `{ agent, messages, step, signal }` and **`next()` returns the decision**;
 *   - a decision carries `messages`; the host's own context plugin inserts one after the last
 *     claimed message with `source: { kind: 'agent-instructions', form: 'instructions' }`;
 *   - enforcement is `return { kind: 'reject' }` — the loop ends the step as `blocked` without a
 *     model request.
 *
 * The earlier version of this file was written from docs and got two of those wrong: it expected
 * `(decision, next)` and set `additionalContexts` on the decision. That field lives on tool results
 * (`tools/result`), not on the pre-step decision, so the block could never have appeared.
 *
 * Enforcement is deliberately NOT re-implemented here. DSH ships `@deepseek-ai/dsh-hooks-claude-code`
 * (0.2.1-rc.2), which runs the consumer's `.claude/settings.json` on its interception seams — that is
 * the pack's guards, one enforcement path rather than two that can disagree. This plugin adds
 * evidence, and rejects on a hard blocker: a named finding from a declared `contract`, `tenant` or
 * `migration` check. A score is never consulted — the checks exclude their own marked exceptions.
 *
 * A reject carries no reason in the host's contract, so every rejection is appended to the product
 * state trail (`eso-blockers.jsonl`) first. A log failure does not weaken the reject.
 */
import { createBlockerRecorder, rejectOnHardBlockers } from '@mu/harness-eso-core';
import { createDshEsoPlugin } from './plugin.mjs';

/** The one hook this plugin registers. */
export const CORDIS_PRE_STEP = 'agent/pre-step';

/**
 * The message source the host's own instructions plugin uses. A caller-supplied `createMessage`
 * should produce a session message with exactly this source, so the host treats it as instructions
 * rather than as a turn the user typed.
 */
export const INSTRUCTIONS_SOURCE = Object.freeze({
    kind: 'agent-instructions',
    form: 'instructions',
    changes: Object.freeze([]),
});

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

/** The last user-authored text in the step, bounded — the only thing preflight needs from payload. */
function userQueryStem(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'user') continue;
        const text = Array.isArray(message.content)
            ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ')
            : typeof message.content === 'string'
              ? message.content
              : '';
        if (text) return text.slice(0, 240);
    }
    return '';
}

/**
 * @param {object} options forwarded to createDshEsoPlugin (root, policy, searchEvents, law…)
 * @param {((text: string) => object)|null} [options.createMessage]
 *   Host message factory. DSH's is `createUserMessage` from `@deepseek-ai/dsh-agent-instructions`.
 *   Without one the plugin still runs preflight, but adds nothing: a fabricated message shape would
 *   be rejected by the session store, and a plugin that throws ends the step.
 * @param {((payload: object) => { ok: boolean, error?: string })|null} [options.recordBlocker]
 *   Where a rejection is recorded. Default: append to `~/.harness/eso-blockers.jsonl` (or
 *   `HARNESS_ESO_BLOCKER_LOG`). `null` disables recording; the reject still happens.
 * @param {((result: object) => boolean)|null} [options.rejectOn]
 *   Predicate over the preflight result. `true` returns `{ kind: 'reject' }`, ending the step as
 *   blocked before a model request. Default `rejectOnHardBlockers` (blockers only; pass
 *   `(r) => rejectOnHardBlockers(r, { strict: true })` to also deny when a declared check was
 *   unreadable). `null` disables rejection entirely.
 */
export function createEsoCordisPlugin(options = {}) {
    const { createMessage = null, rejectOn = rejectOnHardBlockers } = options;
    const recordBlocker =
        options.recordBlocker === undefined
            ? createBlockerRecorder({ root: options.root, file: options.blockerLogFile, host: 'dsh' })
            : options.recordBlocker;
    return {
        name: 'harness-eso',
        inject: ['sessions'],
        apply(ctx, config = {}) {
            const plugin = createDshEsoPlugin({ ...options, ...(config.eso ?? {}) });
            const disposers = [];

            if (typeof ctx?.on === 'function') {
                const off = ctx.on(CORDIS_PRE_STEP, async (payload, next) => {
                    const proceed = typeof next === 'function' ? next : async () => payload;
                    const decision = await proceed();
                    // The host already blocked this step, or is between steps: never overwrite it.
                    if (!decision || decision.kind === 'reject') return decision;
                    if (payload?.signal?.aborted) return decision;

                    const stem = userQueryStem(payload);
                    let result;
                    try {
                        result = await plugin.preflight({ event: 'turn_start', userQueryStem: stem });
                    } catch {
                        /* A failing plugin must not end the turn (DSH ends the step on a throw). */
                        return decision;
                    }

                    if (typeof rejectOn === 'function' && rejectOn(result)) {
                        if (typeof recordBlocker === 'function') {
                            recordBlocker({
                                event: CORDIS_PRE_STEP,
                                kind: result?.hardBlockers?.length ? 'hard-blocker' : 'policy',
                                step: payload?.step ?? null,
                                agent: payload?.agent?.id ?? null,
                                stem: stem || null,
                                blockers: result?.hardBlockers ?? [],
                                errors: result?.checkErrors ?? [],
                            });
                        }
                        return { kind: 'reject' };
                    }

                    const block = buildContextBlock(result);
                    if (!block || typeof createMessage !== 'function') return decision;
                    const message = createMessage(block);
                    if (!message) return decision;

                    const decided = Array.isArray(decision.messages) ? decision.messages : null;
                    if (!decided) return decision;
                    const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
                    const at = decided.findLastIndex((entry) => claimed.includes(entry));
                    /*
                     * Insert after the last message the step has already claimed, which is where the
                     * host's own instructions plugin puts its block — never at the end, where it would
                     * land after tool results the model is about to answer.
                     */
                    return { ...decision, messages: decided.toSpliced(at + 1, 0, message) };
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
