import { buildJevState } from './jev-state-builder.mjs';
import { buildGuardShellPack, buildRouteTieBreakPack } from './jev-question-packs.mjs';
import { postSystemOne } from './jev-client.mjs';
import { parseChoiceAnswer, parseNoulAnswer } from './jev-response-parse.mjs';

function budgetAllows(policy, ctx) {
    const max = policy?.budget?.maxS1PaidCallsPerTurn ?? 1;
    const used = ctx?.jevCallsThisTurn ?? 0;
    return used < max;
}

function mapBucketToDirId(candidates, bucket) {
    const hit = (candidates || []).find((c) => c.bucket === bucket);
    return hit?.dirId ?? (bucket ? `dir:${bucket}` : null);
}

export async function resolveWithJev(input) {
    const { eventType, event, policy, ctx, l0, amb, guard } = input;
    const mode = policy?.jev?.mode ?? 'off';
    if (mode === 'off' || !budgetAllows(policy, ctx)) {
        return { called: false, mode, reason: mode === 'off' ? 'jev_off' : 'budget_exceeded' };
    }

    let pack;
    if (eventType === 'turn_start' && amb?.kind === 'ambiguous') {
        pack = buildRouteTieBreakPack(l0?.candidates ?? [], policy);
    } else if (eventType === 'pre_guard_shell' && guard?.verdict === 'ask') {
        const cmd = event.shellCommand ?? ctx.shellCommand ?? '';
        pack = buildGuardShellPack(cmd);
    } else {
        return { called: false, mode, reason: 'no_pack' };
    }

    const state = buildJevState(event, ctx, policy, { l0, checkSummary: ctx.checkSummary });

    const http = await postSystemOne(
        { model: policy.jev?.model, state, questions: pack.questions },
        { policy, cfg: ctx.cfg, apiKey: ctx.typesafeApiKey ?? ctx.apiKey, fetchImpl: ctx.fetchImpl },
    );

    if (http.skipped) {
        return { called: false, mode, reason: http.error || 'skipped', packId: pack.packId };
    }

    const envelope = {
        packId: pack.packId,
        l0Winner: l0?.winner ?? null,
        httpStatus: http.status,
        error: http.error ?? null,
        jev: http.json ?? null,
    };

    let parsed = null;
    let enforce = null;

    if (pack.packId === 'route.tie_break' && http.ok) {
        const choice = parseChoiceAnswer(http.json, 'route_bucket');
        if (choice?.option) {
            const dirId = mapBucketToDirId(l0?.candidates, choice.option);
            const auto = policy?.thresholds?.choice_auto ?? 0.9;
            const confirm = policy?.thresholds?.choice_confirm ?? 0.5;
            parsed = { type: 'choice', ...choice, dirId };
            enforce = {
                dirId,
                bucket: choice.option,
                confidence: choice.confidence,
                wouldApply: mode === 'active' && choice.confidence >= auto,
                needsConfirm: mode === 'active' && choice.confidence >= confirm && choice.confidence < auto,
            };
            envelope.parsed = parsed;
            envelope.enforce = enforce;
        }
    }

    if (pack.packId === 'guard.shell' && http.ok) {
        const danger = parseNoulAnswer(http.json, 'shell_dangerous');
        const exfil = parseNoulAnswer(http.json, 'shell_exfil');
        const destructive = parseNoulAnswer(http.json, 'shell_destructive');
        const deny = policy?.thresholds?.noul_deny ?? 0.85;
        const allow = policy?.thresholds?.noul_allow ?? 0.2;
        const pMax = Math.max(danger?.probability ?? 0, exfil?.probability ?? 0, destructive?.probability ?? 0);
        let verdict = 'ask';
        if (pMax >= deny) verdict = 'deny';
        else if (pMax <= allow) verdict = 'allow';
        parsed = { type: 'guard', verdict, pMax };
        enforce = { verdict, wouldApply: mode === 'active' };
        envelope.parsed = parsed;
        envelope.enforce = enforce;
    }

    return {
        called: true,
        mode,
        ok: http.ok,
        packId: pack.packId,
        responseJson: JSON.stringify(envelope),
        parsed,
        enforce,
        shadowOnly: mode === 'shadow',
    };
}
