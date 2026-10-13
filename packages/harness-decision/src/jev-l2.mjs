import { resolveWithJev } from '@mu/harness-system-one';

export function applyJevRouteEnforcement(resolved, jev, policy) {
    const mode = policy?.jev?.mode ?? 'off';
    if (mode !== 'active' || !jev?.ok || jev.packId !== 'route.tie_break') return;
    const e = jev.enforce;
    if (!e?.dirId && !e?.bucket) return;

    const auto = policy?.thresholds?.choice_auto ?? 0.9;
    const confirm = policy?.thresholds?.choice_confirm ?? 0.5;
    const conf = Number(e.confidence ?? 0);

    if (conf >= auto || e.wouldApply) {
        resolved.kind = 'route';
        resolved.hilRequired = false;
        resolved.resolverWinner = 'route_jev';
        resolved.route = {
            winnerId: e.dirId,
            bucket: e.bucket,
            confidence: conf,
            ambiguous: false,
            jevEnforced: true,
        };
        return;
    }

    if (conf >= confirm || e.needsConfirm) {
        resolved.hilRequired = true;
        resolved.resolverWinner = 'jev_confirm';
        resolved.route = {
            ...(resolved.route || {}),
            ambiguous: true,
            jevSuggestion: e.bucket,
            winnerId: e.dirId,
            confidence: conf,
        };
    }
}

export function applyJevGuardEnforcement(resolved, jev, policy) {
    const mode = policy?.jev?.mode ?? 'off';
    if (mode !== 'active' || !jev?.ok || jev.packId !== 'guard.shell') return;

    const verdict = jev.enforce?.verdict ?? jev.parsed?.verdict;
    if (!verdict) return;

    if (verdict === 'deny') {
        resolved.guard = { verdict: 'deny', reason: 'jev_guard_deny' };
        resolved.resolverWinner = 'jev_guard_deny';
        resolved.hilRequired = false;
        return;
    }

    if (verdict === 'allow') {
        resolved.guard = { verdict: 'allow', reason: 'jev_guard_allow' };
        resolved.resolverWinner = 'jev_guard_allow';
        resolved.hilRequired = false;
        return;
    }

    resolved.guard = { verdict: 'deny', reason: 'jev_guard_confirm_required' };
    resolved.resolverWinner = 'jev_guard_ask';
    resolved.hilRequired = true;
}

/**
 * L2 — optional Jev call (shadow logs; active enforces).
 * @param {{ eventType: string, event: object, policy: object, ctx: object, resolved: object, resolveFn?: typeof resolveWithJev }} input
 */
export async function maybeInvokeJevL2(input) {
    const { eventType, event, policy, ctx, resolved } = input;
    const mode = policy?.jev?.mode ?? 'off';
    if (mode === 'off') return null;

    const shouldCall =
        (eventType === 'turn_start' && resolved.kind === 'ambiguous') ||
        (eventType === 'pre_guard_shell' && resolved.guard?.verdict === 'ask');
    if (!shouldCall) return null;

    const resolveFn = input.resolveFn || resolveWithJev;
    const tJ = Date.now();
    const jev = await resolveFn({
        eventType,
        event,
        policy,
        ctx,
        l0: resolved.l0,
        amb: resolved,
        guard: resolved.guard,
    });

    if (jev.called) {
        ctx.jevCallsThisTurn = (ctx.jevCallsThisTurn || 0) + 1;
    }

    if (mode === 'active') {
        if (eventType === 'turn_start') applyJevRouteEnforcement(resolved, jev, policy);
        if (eventType === 'pre_guard_shell') applyJevGuardEnforcement(resolved, jev, policy);
    } else if (
        mode === 'shadow' &&
        eventType === 'turn_start' &&
        jev?.called &&
        jev.packId === 'route.tie_break'
    ) {
        resolved.resolverWinner = 'route_jev';
    }

    return { ...jev, latencyMs: Date.now() - tJ };
}
