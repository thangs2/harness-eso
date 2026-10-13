/**
 * Decision facade — L0 + optional L2 Jev (W3).
 */
import { loadDecisionPolicy } from '@mu/harness-foundation/pure';
import { DECISION_EVENT_TYPES } from './decision-types.mjs';
import { hashDecisionRequest, insertDecisionLedger } from './decision-ledger.mjs';
import { resolveL0Route } from './l0-route.mjs';
import { maybeInvokeJevL2 } from './jev-l2.mjs';

/**
 * @param {import('./decision-types.mjs').DecisionEvent} event
 * @param {{
 *   cfg?: object,
 *   policy?: object,
 *   db?: { run: Function, get?: Function },
 *   writeLedger?: boolean,
 *   fetchImpl?: typeof fetch,
 *   jevCallsThisTurn?: number,
 *   resolveJevFn?: Function,
 * }} [ctx]
 */
export async function decide(event, ctx = {}) {
    const eventType = event?.event ?? event;
    if (!DECISION_EVENT_TYPES.includes(eventType)) {
        throw new Error(`decide: unknown event_type ${eventType}`);
    }

    const loaded = ctx.policy
        ? { policy: ctx.policy, path: '', fromFile: false }
        : loadDecisionPolicy(ctx.cfg);
    const policy = loaded.policy;
    const t0 = Date.now();

    let resolved;
    if (eventType === 'pre_guard_shell') {
        const command = event.shellCommand ?? ctx.shellCommand ?? '';
        const deny =
            /\brm\s+-rf\b|\bgit\s+push\s+--force\b/.test(command) ||
            /\bdrop\s+database\b|\bdropdb\b/i.test(command);
        let verdict = 'allow';
        if (deny) verdict = 'deny';
        else if (command.trim() && (policy.jev?.mode ?? 'off') !== 'off') verdict = 'ask';
        resolved = {
            status: 'ok',
            kind: 'guard',
            hilRequired: verdict === 'ask' && policy.on_ambiguous === 'hil_only',
            guard: { verdict, command },
            resolverWinner:
                verdict === 'deny' ? 'l1_shell_deny' : verdict === 'ask' ? 'l1_shell_ask' : 'l1_shell_allow',
            route: { ambiguous: false },
            jevMode: policy.jev?.mode ?? 'off',
        };
    } else {
        const l0 = resolveL0Route(event, policy);
        const amb = l0.tie;
        resolved = {
            status: 'ok',
            kind: amb ? 'ambiguous' : 'route',
            hilRequired: amb && policy.on_ambiguous === 'hil_only',
            route: l0.route ?? { ambiguous: amb, bucket: l0.winner?.bucket, winnerId: l0.winner?.dirId },
            resolverWinner: amb ? 'l0_tie' : 'l0_resolver',
            jevMode: policy.jev?.mode ?? 'off',
            l0,
        };
    }

    const latencyMsL0 = Date.now() - t0;
    let latencyMsJev = 0;
    let jevResponseJson = null;

    const jev = await maybeInvokeJevL2({
        eventType,
        event,
        policy,
        ctx,
        resolved,
        resolveFn: ctx.resolveJevFn ?? ctx.resolveFn,
    });
    if (jev) {
        latencyMsJev = jev.latencyMs ?? 0;
        resolved.jev = jev;
        if (jev.responseJson) jevResponseJson = jev.responseJson;
    }

    if (ctx.writeLedger && ctx.db) {
        const hash = hashDecisionRequest(event, ctx);
        insertDecisionLedger(ctx.db, {
            // `project_id` is NOT optional in practice: every reader scopes by it
            // (`WHERE project_id = ?`), so a row written without it is invisible — the design
            // graph reported "no decision_ledger row" while the row sat in the table. The
            // schema allows NULL, so this fails silently rather than loudly.
            project_id: ctx.projectId ?? null,
            conversation_id: event.sessionId ?? ctx.sessionId ?? null,
            request_id: event.turnId ?? event.sessionId,
            event_type: eventType,
            jev_mode: resolved.jevMode,
            resolver_winner: resolved.resolverWinner,
            enforced_verdict: resolved.guard?.verdict ?? resolved.route?.winnerId ?? resolved.resolverWinner,
            ambiguous_policy: policy.on_ambiguous,
            latency_ms_l0: latencyMsL0,
            latency_ms_jev: latencyMsJev,
            jev_request_hash: hash,
            jev_response_json: jevResponseJson,
        });
    }

    return resolved;
}
