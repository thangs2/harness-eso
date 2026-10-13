/**
 * Read-only agent context strings for live snapshot (WP6.2).
 */

/**
 * @param {{
 *   enforcedVerdict?: string,
 *   resolverWinner?: string,
 *   routeBucket?: string,
 *   confidence?: number,
 * }} decision
 * @param {string[]} attachedRuleStems
 * @returns {{ additionalContext: string } | null}
 */
export function buildAgentHint(decision, attachedRuleStems = []) {
    const parts = [];
    const rules = [...new Set(attachedRuleStems.filter(Boolean))];
    if (rules.length) {
        parts.push(`Attached rules this turn: ${rules.slice(0, 12).join(', ')}.`);
    }

    if (decision?.routeBucket && decision.enforcedVerdict === 'route_l3') {
        const c = decision.confidence != null ? ` (L3 confidence ${Number(decision.confidence).toFixed(2)})` : '';
        parts.push(`System 1 L3 route hint: prefer repo bucket "${decision.routeBucket}"${c}.`);
    } else if (decision?.routeBucket && decision.enforcedVerdict === 'route_jev') {
        const c = decision.confidence != null ? ` (confidence ${Number(decision.confidence).toFixed(2)})` : '';
        parts.push(`System 1 route hint: prefer repo bucket "${decision.routeBucket}"${c}.`);
    } else if (decision?.routeBucket && decision.enforcedVerdict === 'jev_confirm') {
        parts.push(
            `System 1 suggests bucket "${decision.routeBucket}" but confidence is below auto threshold — confirm with human before routing.`,
        );
    }

    if (!parts.length) return null;
    return { additionalContext: parts.join(' ') };
}

/** ESO preflight law-gap → concrete Read paths (greenfield harness-eso). */
export const LAW_GAP_READ_HINTS = {
    'harness-tooling':
        'docgraph --q "harness-tooling"; Read harness-eso `.cursor/rules/core.harness-tooling.mdc`, x79 `17.operational-runbook-eso.md`',
    'decision-facade':
        'docgraph --q "decision-facade"; Read `document/harness/02.harness-eso/02.dpef-v2-pipeline.md`, `07.jev-and-decision-policy.md`',
    'harness-eso':
        'Read `document/harness/02.harness-eso/00.index.md`; harness-eso skill `harness-eso-implement`, rule `core.harness-eso-spec.mdc`',
};

/**
 * Actionable gap → tool mapping for dispatcher (x79 promax).
 * @param {object[]} gaps
 */
export function buildGapFetchPlaybook(gaps) {
    const lines = [];
    for (const g of (gaps || []).slice(0, 10)) {
        const kind = g.kind || 'other';
        const target = g.query || g.path || '?';
        if (kind === 'law' || kind === 'doc') {
            const key = String(target).toLowerCase().trim();
            const hint = LAW_GAP_READ_HINTS[key];
            lines.push(
                hint
                    ? `- law/doc "${target}": ${hint}`
                    : `- law/doc "${target}": docgraph --q "${target}" (or Read document/harness/02.harness-eso, document/mu/, sdlc/)`,
            );
        } else if (kind === 'code' || kind === 'symbol') {
            lines.push(`- code "${target}": codegraph_explore with symbol/path; then Read if needed`);
        } else if (kind === 'memory') {
            lines.push(`- memory "${target}": memory_smart_search`);
        } else if (kind === 'check') {
            lines.push(`- check "${target}": re-run verify / conformance for this request`);
        } else {
            lines.push(`- ${kind} "${target}": fetch evidence before protected writes`);
        }
    }
    return lines.length ? `Gap fetch playbook:\n${lines.join('\n')}` : '';
}

/**
 * Preflight file for Brain / dispatcher (`injectBrainBlock` policy).
 * @param {object|null} pre — from `.eso-preflight.json`
 */
export function buildEvidencePreflightBlock(pre) {
    if (!pre?.ok) return null;
    const parts = [];
    const level = pre.level || 'partial';
    parts.push(`ESO preflight: ${level} (score ${Number(pre.score ?? 0).toFixed(2)}).`);
    if (pre.metrics?.latencyMsTotal != null) {
        parts.push(
            `preflight metrics: ${pre.metrics.latencyMsTotal}ms total`
                + (pre.metrics.jevCalled ? ` · Jev ${pre.metrics.latencyMsJev}ms` : ''),
        );
    }
    const gapPlaybook = buildGapFetchPlaybook(pre.gaps);
    if (gapPlaybook) parts.push(gapPlaybook);
    const gaps = (pre.gaps || [])
        .slice(0, 8)
        .map((g) => `${g.kind}:${g.query || g.path || '?'}`)
        .join('; ');
    if (gaps) parts.push(`Gaps (indexed): ${gaps}.`);
    if (pre.stitchedContext) {
        parts.push(`[EVIDENCE CONTEXT]\n${pre.stitchedContext.slice(0, 8000)}`);
    }
    if (pre.brainTierHint && pre.brainTierHint !== 'none') {
        parts.push(`brainTierHint: ${pre.brainTierHint} (advisory only — Brain tier router in AGENTS.md wins).`);
    }
    if (pre.enforceWrites === 'fail_closed' && pre.allowWrite === false) {
        parts.push('enforceWrites: fail_closed — protected writes blocked until sufficient evidence (Brain may still run).');
    }
    return parts.length ? parts.join('\n\n') : null;
}

/**
 * ESO hint when `eso.mode` is hint or fail_closed (live postToolUse).
 * @param {object|null} bundle — EvidenceBundle
 * @param {string} [esoMode]
 */
export function buildEvidenceHint(bundle, esoMode = 'observe') {
    if (!bundle || (esoMode !== 'hint' && esoMode !== 'fail_closed')) return null;
    const parts = [];
    const { level, score, gaps } = bundle.sufficiency || {};
    if (level) {
        parts.push(`ESO sufficiency: ${level} (score ${Number(score ?? 0).toFixed(2)}).`);
    }
    if (level === 'partial' || level === 'insufficient') {
        const playbook = buildGapFetchPlaybook(gaps);
        if (playbook) parts.push(playbook);
        const gapTxt = (gaps || [])
            .slice(0, 6)
            .map((g) => `${g.kind}:${g.query || g.path || '?'}`)
            .join('; ');
        if (gapTxt) parts.push(`Evidence gaps — fetch before implementing: ${gapTxt}.`);
    }
    if (bundle.stitchedContext) {
        const clip = bundle.stitchedContext.slice(0, 2000);
        parts.push(`Evidence bundle (excerpt): ${clip}`);
    }
    if (bundle.hilQuestions?.length) {
        parts.push(`HIL: ${bundle.hilQuestions[0]}`);
    }
    if (!parts.length) return null;
    return { additionalContext: parts.join(' ') };
}

/**
 * @param {{ additionalContext?: string }|null} a
 * @param {{ additionalContext?: string }|null} b
 */
export function mergeAgentHints(a, b) {
    const parts = [a?.additionalContext, b?.additionalContext].filter(Boolean);
    if (!parts.length) return null;
    return { additionalContext: parts.join(' ') };
}

/**
 * @param {string|null} jevResponseJson
 */
export function parseJevRouteBucket(jevResponseJson) {
    if (!jevResponseJson) return null;
    try {
        const env = JSON.parse(jevResponseJson);
        return env?.enforce?.bucket ?? env?.parsed?.option ?? null;
    } catch {
        return null;
    }
}
