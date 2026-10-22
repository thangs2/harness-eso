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
import { decideToolCall, resolveRoot } from './guards.mjs';

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
    return {
        name: 'harness-eso',
        /* No service injection: the gate reads the consumer's files, not DSH state. */
        inject: [],
        apply(ctx, config = {}) {
            const log = makeLogger(ctx);
            const configRoot = config.root || defaults.root || null;
            const onDecision = typeof defaults.onDecision === 'function' ? defaults.onDecision : null;

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
                    const decision = decideToolCall({
                        root: resolveRoot({ configRoot, args: exec?.arguments }),
                        name: exec?.name,
                        args: exec?.arguments ?? {},
                    });
                    if (decision) {
                        report(decision, 'tools/pre-execute');
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
             * P0/P1: no prompt gate yet. Registered so the row proves the event name is accepted; it
             * decides nothing and always delegates. P2 replaces this with preflight + hard blockers.
             */
            const offStep = ctx.on('agent/pre-step', async (payload, next) => {
                const decision = await next();
                if (decision?.kind !== 'enter') return decision;
                log(`pre-step: turn ${payload?.turn ?? '?'} allowed`);
                return decision;
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
