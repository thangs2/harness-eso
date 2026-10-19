import { loadContextContract, compilePinnedInvariants } from './context-contract.mjs';

/**
 * Preflight projection — the `.eso-preflight.json` document every host hook reads.
 *
 * Single source of truth for this shape. It used to be built inline in the observe-server
 * HTTP route, which meant the host could only obtain it by calling the sidecar. The host pack
 * now runs COLLECT + GATE in-process, so both callers must produce a byte-identical
 * projection from the same `orchestrateTurn` result — otherwise `guard-brain`, the ESO write
 * gate and `post-tool-hint` would read a different document depending on how preflight ran.
 *
 * @param {object} turn      the host event that triggered preflight
 * @param {object} result    `orchestrateTurn` return value
 * @param {{ latencyMs?: number, root?: string, cfg?: object, contract?: object, policy?: object }} [opts]
 */
export function buildPreflightProjection(turn, result, opts = {}) {
    const verdict = result.verdict || {};
    const sufficiency = verdict.sufficiency || {};
    const level = sufficiency.level ?? verdict.level;
    const surface = result.facade?.route
        ? { bucket: result.facade.route.bucket }
        : { bucket: result.facade?.l0?.winner?.bucket ?? 'general' };

    const root = opts.root || opts.cfg?.root || turn.root;
    const contract = opts.contract || (root ? loadContextContract(root, opts.contractPath || opts.policy?.eso?.contextContractPath) : null);
    const pinnedInvariants = extractPinnedInvariants(result, {
        root,
        contract,
        stem: turn.userQueryStem,
        paths: turn.touchedPaths || turn.paths,
        domainHint: turn.domainHint || opts.domainHint,
    });
    const domain = contract && !contract.contractMissing
        ? (compilePinnedInvariants(contract, { stem: turn.userQueryStem, paths: turn.touchedPaths || turn.paths, domainHint: turn.domainHint }).domain)
        : null;

    const cognitiveState = level === 'sufficient' ? 'WARM' : (turn.fingerprint ? 'STALE' : 'COLD');

    return {
        ok: level !== 'insufficient' || verdict.allowPromptSubmit,
        at: verdict.at,
        harnessTree: turn.harnessTree || 'cursor',
        generationId: turn.generationId ?? turn.turnId ?? null,
        conversationId: turn.conversationId ?? null,
        userQueryStem: String(turn.userQueryStem || ''),
        fingerprint: turn.fingerprint ?? null,
        cognitiveState,
        pinnedInvariants,
        domain: domain ?? surface.bucket ?? null,
        contractMissing: contract ? Boolean(contract.contractMissing) : true,
        allowWrite: verdict.allowProtectedWrite,
        level,
        score: sufficiency.score ?? verdict.score ?? 0,
        mode: verdict.esoMode,
        enforceWrites: verdict.enforceWrites,
        gaps: sufficiency.gaps ?? verdict.gaps ?? [],
        brainTierHint: turn.brainTierHint || 'flash',
        surface,
        metrics: { latencyMsTotal: opts.latencyMs ?? 0 },
        verdict,
    };
}

/**
 * Extracts recognized invariant / rule codes from verified retrieval snippets and pack requirements.
 * When a Context Contract is present, compiles and scopes invariants to the active domain.
 *
 * @param {object} result
 * @param {object} [opts]
 * @returns {string[]}
 */
export function extractPinnedInvariants(result, opts = {}) {
    const invSet = new Set();
    const snippets = result?.retrieval?.snippets || result?.collected?.retrieval?.snippets || [];
    for (const s of snippets) {
        if (!s.text) continue;
        const matches = s.text.match(/(?:INV|LAW|RULE|SEC)-[A-Z0-9_-]+/gi);
        if (matches) {
            for (const m of matches) {
                invSet.add(m.toUpperCase());
            }
        }
    }
    for (const term of result?.pack?.requiredDocTerms || []) {
        if (/(?:INV|LAW|RULE|SEC)-/i.test(term)) {
            invSet.add(term.toUpperCase());
        }
    }
    const detected = Array.from(invSet);

    const root = opts.root || opts.cfg?.root;
    if (root) {
        const contract = opts.contract || loadContextContract(root, opts.contractPath || opts.policy?.eso?.contextContractPath);
        if (!contract.contractMissing) {
            const compiled = compilePinnedInvariants(contract, {
                stem: opts.stem || opts.userQueryStem,
                paths: opts.paths || opts.touchedPaths,
                domainHint: opts.domainHint,
                attestedInvariants: detected,
            });
            if (compiled.pinnedInvariants.length > 0) {
                return compiled.pinnedInvariants.slice(0, 5);
            }
        }
    }

    return detected.slice(0, 5);
}

/** The projection written when ESO is disabled — still a valid document for the other hooks. */
export function skippedPreflightProjection(reason) {
    return { ok: true, skipped: true, reason, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
