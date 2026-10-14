import { loadDecisionPolicy } from '@mu/harness-foundation';
import { liveConsents } from '@mu/harness-foundation/consent';

function gapToPlaybookSteps(gaps) {
    return (gaps || []).slice(0, 12).map((g, i) => {
        const target = g.query || g.path || g.id || g.message || '?';
        const kind = g.kind || 'other';
        let label = `${kind}: ${target}`;
        if (kind === 'law' || kind === 'doc') label = `Read / docgraph — ${target}`;
        if (kind === 'code' || kind === 'symbol') label = `codegraph_explore — ${target}`;
        if (kind === 'memory') label = `memory_smart_search — ${target}`;
        return { id: g.id || `gap-${i}`, label, hint: g.message || target };
    });
}

function normalizeGaps(bundle, summary) {
    const raw = bundle?.sufficiency?.gaps || summary?.gaps || [];
    return raw.map((g, i) => ({
        id: g.id || `${g.kind || 'gap'}:${g.query || g.path || i}`,
        kind: g.kind,
        message: g.message || g.query || g.path,
    }));
}

/**
 * The **live** consent records for this project, from product state.
 *
 * This used to read `.eso-consent-waiver.json` out of the session directory — a path the agent must be
 * able to write, because its own Brain stamp lives beside it. So the card reported "continued" on the
 * strength of a file only the agent could have written, and nothing enforced it: the record was read
 * here and by no guard at all. On top of that it read **either** tree, so a waiver in `.cursor/` spoke
 * for Antigravity too.
 *
 * Consent now comes from `<product state>/consent/<projectId>.json`, written by the console's
 * `POST /api/projects/:id/consent` and by nothing else. See `consent.mjs`.
 */
function readConsents(cfg) {
    const projectId = cfg?.project?.id;
    if (!projectId) return [];
    try {
        return liveConsents(projectId);
    } catch {
        // Unreadable is "no consent", never "consent".
        return [];
    }
}

/**
 * Observatory ConsentGateCard slice — merged into RequestDetailVM (spec §3.3).
 */
export function buildConsentVm(cfg, evidence) {
    const bundle = evidence?.bundle;
    const summary = evidence?.summary || {};
    const { policy } = loadDecisionPolicy(cfg);
    const cognition = policy?.eso?.cognition || {};
    const gate = cognition.insufficientPromptGate || 'consent';
    const level = summary.level || bundle?.sufficiency?.level || 'unknown';
    const score = summary.score ?? bundle?.sufficiency?.score ?? null;
    const gaps = normalizeGaps(bundle, summary);
    const consents = readConsents(cfg);
    const newest = consents[0] || null;

    const esoMode = policy?.eso?.mode ?? 'observe';
    const enforceWrites = policy?.eso?.enforceWrites ?? 'off';

    let outcome = 'pending';
    if (level === 'sufficient' && gaps.length === 0) outcome = 'not_required';
    else if (newest) outcome = 'continue';
    else if (gate === 'consent' && level === 'insufficient' && enforceWrites === 'fail_closed') {
        outcome = 'blocked';
    }

    return {
        eso: {
            sufficiency: level,
            score,
            gaps,
            recoveryPlaybook: gapToPlaybookSteps(gaps),
        },
        consent: {
            outcome: outcome === 'not_required' ? 'continue' : outcome,
            at: newest?.at || null,
            waiverId: newest?.id || null,
            // What was actually approved, and by whom. The old shape carried a bare id, so the card could
            // say "continued" without being able to show on whose authority or for which path — which is
            // how an agent-issued claim read as a human decision.
            path: newest?.path || null,
            approvedBy: newest?.approvedBy || null,
            expiresAt: newest?.expiresAt || null,
            liveCount: consents.length,
        },
        preflight: {
            injectBrainBlock: level !== 'sufficient' || gaps.length > 0,
        },
        policySnapshot: {
            eso: {
                mode: esoMode,
                enforceWrites,
                // Thresholds travel with the snapshot so the UI can show WHY a score landed in
                // a band. Without them a bare "0.37" is unreadable — the reader cannot tell
                // whether that is close to sufficient or nowhere near it, and inventing bands
                // in the UI would drift from policy.
                thresholds: {
                    T_low: policy?.eso?.thresholds?.T_low ?? null,
                    T_high: policy?.eso?.thresholds?.T_high ?? null,
                },
                cognition: { insufficientPromptGate: gate },
                preflight: { jevOnPartial: policy?.eso?.preflight?.jevOnPartial === true },
            },
        },
    };
}
