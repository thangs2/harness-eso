/**
 * harness-eso as a DSH plugin package.
 *
 * Why this shape: the hooks bridge (`@deepseek-ai/dsh-hooks-claude-code`) is not shipped inside
 * `app.asar`, so installing it drags app-shipped packages into the profile, and a second instance of
 * `dsh-tools` splits `Symbol()` identity — every tool call then dies at `.prepare(...)` (ATF-OPS-001).
 * This plugin has **no dependencies at all** after bundling: it imports only `node:*` and the ESO
 * modules compiled into `dist/eso-plugin.mjs`. There is nothing for the package manager to hoist, so
 * the pathology cannot recur by construction.
 *
 * Installed through DSH's own Plugins UI (a bundle whose `cordis.patch.yml` inserts one row). No DSH
 * file is edited, and no profile file is written by hand.
 *
 * Failure posture: every handler catches. An exception inside a plugin ends the step, so a bug here
 * must not be allowed to break the user's turn; the deny path is the only place that intentionally
 * stops something, and only when the consumer's policy says so.
 */
import { loadDecisionPolicy } from '@mu/harness-foundation/pure';

/*
 * Imported by path, not through the core barrel: the barrel re-exports the ledger and the decision
 * facade, and those reach SQLite. The bundle must stay `node:*`-only, so this pulls exactly the three
 * modules the prompt gate needs.
 */
import { appendBlockerRecord, createBlockerRecorder } from '../../harness-eso-core/src/blocker-log.mjs';
import { loadCheckInputs, hardBlockersFromChecks } from '../../harness-eso-core/src/hard-blockers.mjs';
import { resolveEsoPolicy } from '../../harness-eso-core/src/eso-policy.mjs';
import { decideToolCall, findConsumerRoot } from './guards.mjs';

/** Last user-authored text in the step, bounded — what the trail records as the trigger. */
function userStem(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;
        const text = Array.isArray(message.content)
            ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ')
            : typeof message.content === 'string'
              ? message.content
              : '';
        if (text) return text.slice(0, 240);
    }
    return null;
}

/** One line per event so a user can see the plugin is alive and what it decided. */
function makeLogger(ctx) {
    const logger = typeof ctx?.logger?.info === 'function' ? ctx.logger : null;
    return (message) => {
        try {
            if (logger) logger.info(`harness-eso: ${message}`);
        } catch {
            /* logging must never decide anything */
        }
    };
}

/**
 * The Cordis/DSH plugin object.
 *
 * @param {{ root?: string, onDecision?: (decision: object) => void }} [defaults]
 */
export function createEsoDshPlugin(defaults = {}) {
    /*
     * One recorder for both gates: a rejection and a denied tool call are the same kind of fact, and a
     * consumer must not have to wire two logs. Never throws — `createBlockerRecorder` reports failure.
     */
    const recordBlocker =
        defaults.recordBlocker ?? createBlockerRecorder({ root: defaults.root, host: 'dsh' });
    return {
        name: 'harness-eso',
        /*
         * `workingDirectory` is the only DSH service this needs: `get(session)` is the real cwd of the
         * tool call, which a shell command's pre-expansion text cannot tell us. No import — the service
         * is injected, so nothing from `@deepseek-ai/*` enters the bundle.
         */
        inject: ['workingDirectory'],
        apply(ctx, config = {}) {
            const log = makeLogger(ctx);
            const configRoot = config.root || defaults.root || null;
            /* `host` delegates a not-yet-approved path to the host's approval UI; the default denies,
             * because a host `ask` was measured to let the write through. */
            const askMode = config.askMode === 'host' ? 'host' : 'deny';
            /* Row config is data; the plugin factory is the test/programmatic seam. Config wins. */
            const declaredChecks = config.checks ?? defaults.checks ?? null;
            /* Every deny is recorded by default; a consumer that wants a quiet trail can turn it off. */
            const recordToolDecisions = config.recordToolDecisions !== false && defaults.recordToolDecisions !== false;
            const onDecision = typeof defaults.onDecision === 'function' ? defaults.onDecision : null;

            /** The session's effective directory, or null when the service or session is absent. */
            const sessionDirOf = (agent) => {
                try {
                    const session = agent?.session;
                    if (!session || typeof ctx?.workingDirectory?.get !== 'function') return null;
                    const dir = ctx.workingDirectory.get(session);
                    return typeof dir === 'string' && dir.startsWith('/') ? dir : null;
                } catch {
                    return null;
                }
            };

            const report = (decision, event) => {
                log(`${event}: ${decision.kind} ${decision.path ?? ''}`.trim());
                if (onDecision) {
                    try {
                        onDecision({ ...decision, event });
                    } catch {
                        /* an observer must not break the gate */
                    }
                }
            };

            if (typeof ctx?.on !== 'function') {
                log('no ctx.on — nothing registered');
                return () => {};
            }

            const disposers = [];

            /*
             * The write/shell gate. This is the one handler that can stop a tool call, and it is the
             * reason the plugin exists: without it there is no enforcement inside DSH.
             */
            const offTool = ctx.on('tools/pre-execute', async (exec, next) => {
                try {
                    // The guard resolves the consumer from what the call writes; passing only a root
                    // here would miss every shell command, whose cwd is the app directory.
                    const decision = decideToolCall({
                        configRoot,
                        sessionRoot: sessionDirOf(exec?.agent),
                        name: exec?.name,
                        args: exec?.arguments ?? {},
                        askMode,
                    });
                    if (decision) {
                        report(decision, 'tools/pre-execute');
                        /*
                         * A denied tool call is a decision too, and the host does not log it: without
                         * this record the only account of a blocked write is the model's own retelling.
                         */
                        if (recordToolDecisions && typeof recordBlocker === 'function') {
                            // The gate already resolved the consumer; reuse it instead of guessing again.
                            const recordRoot =
                                decision.root ??
                                findConsumerRoot(configRoot || sessionDirOf(exec?.agent) || process.cwd());
                            recordBlocker({
                                root: recordRoot || undefined,
                                event: 'tools/pre-execute',
                                kind: decision.kind === 'deny' ? 'tool-deny' : 'tool-ask',
                                tool: exec?.name ?? null,
                                blockers: [
                                    {
                                        source: 'policy',
                                        kind: 'gate-decision',
                                        ref: decision.path ?? null,
                                        detail: decision.reason,
                                    },
                                ],
                            });
                        }
                        return { kind: decision.kind, reason: decision.reason };
                    }
                } catch (err) {
                    /* Cannot decide + cannot even read policy: allow, because this is a tool gate and a
                     * crash-looping plugin would block the whole session. The error is logged. */
                    log(`pre-execute error: ${err?.message ?? err}`);
                }
                return next();
            });
            if (typeof offTool === 'function') disposers.push(offTool);

            /*
             * The prompt gate. It refuses a step only for a **named** finding from the checks the
             * consumer declared in `eso.checks` — never for a score, and never because evidence is thin.
             * The rejection is written to the product-state trail first, because the host's `reject`
             * carries no reason and a blocked step must still be explainable afterwards.
             */
            const offStep = ctx.on('agent/pre-step', async (payload, next) => {
                const decision = await next();
                // Only an entering step is ours; rejecting an already-decided step would overwrite it.
                if (decision?.kind !== 'enter') return decision;
                try {
                    const root = findConsumerRoot(configRoot || sessionDirOf(payload?.agent) || process.cwd());
                    if (!root) return decision;

                    const policy = loadDecisionPolicy({ root }).policy ?? {};
                    const checks = declaredChecks ?? resolveEsoPolicy(policy).checks;
                    if (!checks) return decision;

                    const loaded = loadCheckInputs(root, checks);
                    const { blockers } = hardBlockersFromChecks(loaded);
                    if (!blockers.length) {
                        if (loaded.errors.length) log(`pre-step: ${loaded.errors.length} unreadable check input(s), no blocker`);
                        return decision;
                    }

                    /*
                     * Record first, then reject — but a failed write must not weaken the reject. "Cannot
                     * log" is not evidence that the step was safe, so the trail failure is reported and
                     * the step is still refused.
                     */
                    let trail = null;
                    try {
                        trail = appendBlockerRecord({
                            root,
                            host: 'dsh',
                            event: 'agent/pre-step',
                            kind: 'hard-blocker',
                            step: payload?.turn ?? null,
                            stem: userStem(payload),
                            blockers,
                            errors: loaded.errors,
                        });
                    } catch (err) {
                        log(`pre-step: trail write failed (${err?.message ?? err}) — rejecting anyway`);
                    }
                    log(`pre-step: reject — ${blockers.length} blocker(s)${trail ? ` via ${trail.file}` : ''}`);
                    return { kind: 'reject' };
                } catch (err) {
                    /* A prompt gate that throws would end the step anyway; let it be the host's decision. */
                    log(`pre-step error: ${err?.message ?? err}`);
                    return decision;
                }
            });
            if (typeof offStep === 'function') disposers.push(offStep);

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

export default createEsoDshPlugin();
