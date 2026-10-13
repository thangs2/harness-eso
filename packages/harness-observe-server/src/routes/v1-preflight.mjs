import fs from 'node:fs';
import path from 'node:path';
import { buildPreflightProjection, orchestrateTurn, skippedPreflightProjection } from '@mu/harness-eso-core';
import { loadDecisionPolicy } from '@mu/harness-foundation';

/**
 * Map orchestrateTurn output → host `.eso-preflight.json` projection (shard 14 / eso-preflight.schema).
 * @param {object} cfg observe config
 * @param {object} turn harness event
 * @param {object} [opts]
 */
/**
 * POST /v1/preflight — the HTTP form of the preflight projection.
 *
 * Kept because it is an existing route in the published surface, but note that **no host hook calls
 * it any more**: the host pack runs the same COLLECT + GATE in-process (`preflight-hook.mjs`) so that
 * prompt submission does not depend on the observe plane being up. Both paths share
 * `buildPreflightProjection`, so they cannot drift.
 */
export async function runV1Preflight(cfg, turn, opts = {}) {
    const policy =
        opts.policy ?? loadDecisionPolicy({ root: cfg.root, decisionPolicyPath: cfg.decisionPolicyPath }).policy;
    const esoCfg = { root: cfg.root, decisionPolicyPath: cfg.decisionPolicyPath };
    const t0 = Date.now();
    const result = await orchestrateTurn(
        {
            event: 'turn_start',
            kernelEvent: turn.event ?? 'prompt.submitted',
            turnId: turn.turnId ?? turn.generationId ?? turn.requestId,
            userQueryStem: turn.userQueryStem ?? '',
            conversationId: turn.conversationId,
            generationId: turn.generationId,
            harnessTree: turn.harnessTree,
            touchedPaths: turn.touchedPaths,
            brainTierHint: turn.brainTierHint,
        },
        { phase: 'preflight', cfg: esoCfg, policy, ...opts.orchestrate },
    );
    if (result.skipped) {
        return skippedPreflightProjection(result.reason);
    }
    // One builder for both callers. The host pack runs the same COLLECT+GATE in-process; if this
    // route kept its own copy of the projection, the two would drift and `guard-write` /
    // `guard-brain` would read a different document depending on how preflight ran.
    const projection = buildPreflightProjection(turn, result, { latencyMs: Date.now() - t0 });
    if (opts.writeSession !== false && turn.harnessTree) {
        writePreflightSession(cfg, turn.harnessTree, projection);
    }
    return projection;
}

function writePreflightSession(cfg, tree, projection) {
    const dir =
        tree === 'agents'
            ? path.join(cfg.root, '.agents', 'session')
            : path.join(cfg.root, '.cursor', 'session');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.eso-preflight.json'), `${JSON.stringify(projection, null, 2)}\n`);
}

/**
 * @param {object} cfg
 * @param {{ path?: string, tool?: string, requestId?: string }} body
 */

