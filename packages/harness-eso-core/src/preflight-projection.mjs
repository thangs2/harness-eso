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
    const lawMisses = extractLawMisses(result);

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
        /** `declared` or `default` — the consumer wrote `enforceWrites`, or the strict default supplied it (G-08). */
        enforceWritesSource: verdict.enforceWritesSource,
        gaps: sufficiency.gaps ?? verdict.gaps ?? [],
        lawMisses,
        /**
         * The gaps nothing in this repo can close (G-02), and why. A reader that receives a deny must
         * be able to tell "you have not read it" from "reading will not help" — the second one is the
         * operator's problem, not the agent's, and before this field both looked identical.
         */
        unanswerableGaps: (sufficiency.gaps ?? verdict.gaps ?? [])
            .filter((g) => g?.unanswerable === true)
            .map((g) => ({ id: `${g.kind}:${g.query}`, reason: 'law adapter returned no rows for this term' })),
        /**
         * The pack this verdict was measured against. Without it a deny is not reproducible: the gap
         * set is a function of the pack, and `atrievefin`'s stuck gate could not be explained from its
         * own `.eso-preflight.json` because the document did not say which terms were being demanded.
         */
        pack: result.pack ? { bucket: result.pack.bucket, requiredDocTerms: result.pack.requiredDocTerms ?? [] } : null,
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

/**
 * Law terms the retrieval adapter could not answer.
 *
 * `runCollect` already records one trace line per fetched term (`docgraph:ok:<term>`,
 * `docgraph:miss:<term>`), but the projection dropped it, so the one fact that explains a stuck gate —
 * *the law index does not contain this term* — never reached the agent. On `fineso` that produced
 * P-26: a `law:harness-tooling` gap that could not be closed by any reading, retried every turn with
 * no diagnostic, and the turn ended by blaming the tool instead of the index.
 *
 * @param {object} result
 * @returns {string[]} the terms that returned nothing
 */
export function extractLawMisses(result) {
    const trace = result?.retrieval?.trace || result?.collected?.retrieval?.trace || [];
    if (!Array.isArray(trace)) return [];
    const misses = [];
    for (const line of trace) {
        const m = typeof line === 'string' ? line.match(/^docgraph:miss:(.+)$/) : null;
        if (m && m[1] && !misses.includes(m[1])) misses.push(m[1]);
    }
    return misses;
}

/**
 * The projection written when ESO is disabled — still a valid document for the other hooks. */
export function skippedPreflightProjection(reason) {
    return { ok: true, skipped: true, reason, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
