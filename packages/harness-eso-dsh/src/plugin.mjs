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
import { loadDecisionPolicy, readEsoAttestation, writeEsoAttestation } from '@mu/harness-foundation/pure';

/*
 * Imported by path, not through the core barrel: the barrel re-exports the ledger and the decision
 * facade, and those reach SQLite. The bundle must stay `node:*`-only, so this pulls exactly the three
 * modules the prompt gate needs.
 */
import { appendBlockerRecord, createBlockerRecorder } from '../../harness-eso-core/src/blocker-log.mjs';
import { loadCheckInputs, hardBlockersFromChecks } from '../../harness-eso-core/src/hard-blockers.mjs';
import { resolveEsoPolicy } from '../../harness-eso-core/src/eso-policy.mjs';
import { receiptMatchesVerdict, writeDshAttestation } from './attestation.mjs';
import { isCompletedBrainCall, recordBrainCall } from './brain-attestation.mjs';
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

            /**
             * Whether the "no eso.checks + fail_closed" deadlock has already been reported.
             *
             * Per plugin instance, which is per session in practice. The condition is a standing
             * configuration fact, so repeating it on every entering step would train an operator to
             * ignore the one line that explains why their writes are refused.
             */
            let noChecksWarned = false;

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
             * The Brain gate's evidence on DSH.
             *
             * `guard-write.py` normally reads the DeepSeek usage ledger for this, which works on Cursor and
             * Antigravity because the MCP server writes it from a process the agent cannot reach. DSH's
             * sandbox gives that child no write access to product state, so the ledger never gains the row
             * and the guard reports "no Brain call" for calls that completed. Moving the ledger somewhere
             * writable would put forgeable evidence inside the agent's reach, which is worse than the
             * problem. So the plugin witnesses the call itself: this listener fires in the host's tool
             * pipeline, not on any path the agent can drive.
             */
            const offBrain = ctx.on('tools/post-execute', async (exec, result, next) => {
                try {
                    if (isCompletedBrainCall(exec, result)) {
                        const root = findConsumerRoot(configRoot || sessionDirOf(exec?.agent) || process.cwd());
                        if (root) {
                            const wrote = recordBrainCall({
                                root,
                                tool: exec?.name,
                                writeEsoAttestation,
                                readEsoAttestation,
                            });
                            if (!wrote.written) log(`brain: attestation not written — ${wrote.reason}`);
                            else log(`brain: recorded ${exec?.name}`);
                        }
                    }
                } catch (err) {
                    /*
                     * A witness that throws would turn a successful model call into a failed tool call.
                     * The gate's behaviour without this record is the well-defined one it had before:
                     * the ledger, then the stamp, then a deny.
                     */
                    log(`brain: post-execute error — ${err?.message ?? err}`);
                }
                return next();
            });
            if (typeof offBrain === 'function') disposers.push(offBrain);

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
                    const eso = resolveEsoPolicy(policy);
                    const checks = declaredChecks ?? eso.checks;
                    if (!checks) {
                        /*
                         * A consumer that declares `enforceWrites: fail_closed` but no `eso.checks` cannot
                         * reach `allowWrite: true` on this host, and the failure is silent. Measured on
                         * BA Platform: the attestation on disk said `allowWrite: false` from an earlier
                         * run, this handler returned here, and `guard-write.py` — which checks the ESO gate
                         * *before* the Brain gate — denied every protected write with `DENY_ESO`. An agent
                         * reading that denial goes looking for a Brain problem, makes a Brain call, the
                         * witness records it correctly, and the write is still refused. The deadlock is not
                         * obvious from any single message, so it is named here instead.
                         *
                         * Logged once per session, not once per step: this is a standing configuration
                         * fact, and a line per step would be noise an operator learns to skip.
                         */
                        if (!noChecksWarned && eso.enforceWrites === 'fail_closed') {
                            noChecksWarned = true;
                            log(
                                'pre-step: no eso.checks declared for this consumer, and eso.enforceWrites is ' +
                                    'fail_closed. The evidence attestation will not be written, so ' +
                                    'guard-write.py keeps whatever allowWrite the attestation already holds — ' +
                                    'protected writes will be denied with "ESO gate" even after a successful ' +
                                    'Brain call. Declare eso.checks in .harness/decision-policy.json, or raise ' +
                                    'eso.enforceWrites, or accept that this host does not do gated writes.',
                            );
                        }
                        return decision;
                    }

                    const loaded = loadCheckInputs(root, checks);
                    const { blockers } = hardBlockersFromChecks(loaded);

                    /*
                     * The evidence gate's input. `guard-write.py` prefers
                     * `<product-state>/attest/<pid>.json` over the session stamp, and until this existed
                     * nothing on DSH wrote it — so with `enforceWrites: fail_closed` every protected write
                     * was refused for "no evidence" before the Brain gate was even consulted. Written
                     * here, not by a tool call, which is the same trust status the pack's preflight hook
                     * has on the other hosts.
                     *
                     * One write per **verdict change**, not one per step: a rewrite on every step appends
                     * to product state forever and makes "when did the verdict change" unanswerable. The
                     * comparison is on what this step measured, not on whether a file exists — checking
                     * "is there a receipt saying allow" skipped the write exactly when a check had just
                     * started failing, leaving the guard reading the previous allow and admitting the very
                     * write this step blocked.
                     */
                    try {
                        const verdict = { allowWrite: blockers.length === 0 && loaded.errors.length === 0 };
                        if (!receiptMatchesVerdict(root, verdict)) {
                            const wrote = writeDshAttestation({ root, policy, blockers, errors: loaded.errors });
                            if (!wrote.written) log(`pre-step: attestation not written — ${wrote.reason}`);
                        }
                    } catch (err) {
                        /* Evidence must never be the reason a step fails; the guard denies without it. */
                        log(`pre-step: attestation error — ${err?.message ?? err}`);
                    }

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
