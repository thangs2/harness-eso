import fs from 'node:fs';
import path from 'node:path';
import { loadDecisionPolicy, sessionDir } from '@mu/harness-foundation';

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

function readWaiver(cfg) {
    for (const tree of ['cursor', 'agents']) {
        const p = path.join(sessionDir(cfg.root, tree), '.eso-consent-waiver.json');
        if (!fs.existsSync(p)) continue;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            /* ignore */
        }
    }
    return null;
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
    const waiver = readWaiver(cfg);

    const esoMode = policy?.eso?.mode ?? 'observe';
    const enforceWrites = policy?.eso?.enforceWrites ?? 'off';

    let outcome = 'pending';
    if (level === 'sufficient' && gaps.length === 0) outcome = 'not_required';
    else if (waiver?.waiverId || waiver?.id) outcome = 'continue';
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
            at: waiver?.at || null,
            waiverId: waiver?.waiverId || waiver?.id || null,
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
