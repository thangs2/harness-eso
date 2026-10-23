/**
 * Preflight — COLLECT + GATE for one turn, run **in the host pack**.
 *
 * This used to POST `/v1/preflight` on the observe sidecar. That made prompt submission depend
 * on the observe plane being up, which contradicts the standalone goal: guards, routing and
 * preflight must survive with Docker stopped. `orchestrateTurn` is pure — it reads the consumer
 * policy and shells out to the consumer's own docgraph/codegraph — so the sidecar hop bought
 * nothing but a dependency.
 *
 * The projection is built by `@mu/harness-eso-core`'s shared builder, the same one the HTTP route
 * uses, so both paths produce an identical `.eso-preflight.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildPreflightProjection, orchestrateTurn } from '@mu/harness-eso-core';
import { computeFastFingerprint, findRepoRoot } from '@mu/harness-foundation/pure';
import { detectShape, emitHook, harnessTree, loadPolicyForCwd, readStdin, sessionDir } from './hook-io.mjs';
import { mergeGapClosure, readLawMisses, readPreflight, rememberLawMisses, writeBundleStampFromPreflight } from './eso-gap-io.mjs';

/**
 * The one-line instruction a hint-mode preflight leaves for the agent.
 *
 * P-26: `Gaps: law` alone was not enough to act on, and when the law index was the blocker the gap was
 * *unclosable* — the agent retried, failed, and eventually told the operator the harness was broken. A
 * miss is stated as a fact about the index, with the escape hatch, so the turn can move on.
 */
function buildEvidencePreflightBlock(pre) {
    if (!pre) return '';
    const parts = [];
    parts.push(`ESO preflight: ${pre.level} (score ${Number(pre.score ?? 0).toFixed(2)}).`);
    if (Array.isArray(pre.gaps) && pre.gaps.length) {
        parts.push(`Gaps: ${pre.gaps.map((g) => g.kind || g.query || 'gap').join(', ')}.`);
    }
    if (Array.isArray(pre.lawMisses) && pre.lawMisses.length) {
        const known = Array.isArray(pre.lawMissesKnown) && pre.lawMissesKnown.length ? ` (already recorded for this repo: ${pre.lawMissesKnown.join(', ')})` : '';
        parts.push(
            `Law index returned nothing for: ${pre.lawMisses.join(', ')}${known} — reading cannot close these; cite the gap in the answer instead of retrying.`,
        );
    }
    return parts.join(' ');
}

function stemFromPrompt(data) {
    let prompt = data.prompt ?? data.user_message ?? data.message ?? '';
    if (!prompt && typeof data.transcriptPath === 'string' && fs.existsSync(data.transcriptPath)) {
        try {
            const lines = fs.readFileSync(data.transcriptPath, 'utf8').trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                const step = JSON.parse(line);
                if (step.type === 'USER_INPUT' && step.content) {
                    prompt = step.content;
                    break;
                }
            }
        } catch {
            // ignore transcript read error
        }
    }
    return String(prompt)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

/** Consumer root for this turn: the config anchor, falling back to the host's cwd. */
function consumerRoot() {
    return findRepoRoot(process.cwd()) || process.cwd();
}

/**
 * Did the consumer's own `decision-policy.json` name `eso.sources`? (G-01)
 *
 * Asked **before** `loadDecisionPolicy` merges `DEFAULT_ESO_POLICY.sources` into the document, because
 * after that merge "never declared" and "declared as the default" are the same value. The answer
 * travels down as `eso.sourcesDeclared` and `orchestrateTurn` decides what it means — the ingest
 * worker runs the same fold, so a decision taken only here would be a verdict the observe plane
 * disagrees with.
 */
function readDeclaredSources(root) {
    if (!root) return false;
    const fp = path.join(root, '.harness', 'decision-policy.json');
    try {
        if (!fs.existsSync(fp)) return false;
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return Boolean(raw && typeof raw === 'object' && raw.eso && typeof raw.eso === 'object' && raw.eso.sources);
    } catch {
        return false;
    }
}

export async function run() {
    let data = {};
    let shape = 'cursor';
    try {
        const raw = await readStdin();
        data = raw.trim() ? JSON.parse(raw) : {};
        shape = detectShape(data);
    } catch {
        emitHook({ permission: 'allow', esoPreflightError: 'invalid_json' }, shape);
        return;
    }

    const tree = harnessTree();
    const root = consumerRoot();
    const sessionId =
        data.conversation_id ?? data.session_id ?? data.conversationId ?? data.sessionId ?? '';
    const generationId = data.generation_id ?? data.generationId ?? '';
    const requestId = generationId || sessionId || `preflight-${Date.now()}`;
    const currentStem = stemFromPrompt(data);
    const currentFp = computeFastFingerprint({ stem: currentStem, root });

    // Antigravity fires PreInvocation before EVERY LLM call (invocationNum: 0, 1, 2...).
    // For continuation steps (invocationNum > 0) in the same session, do not wipe gap closure
    // UNLESS the prompt changed (intent drift) or repository state changed (dirty index)!
    const isContinuation =
        (typeof data.invocationNum === 'number' && data.invocationNum > 0) ||
        data.isContinuation === true;

    if (isContinuation) {
        const existingPre = readPreflight(root, tree);
        const effectiveStem = currentStem || existingPre?.userQueryStem || '';
        const effectiveFp = computeFastFingerprint({ stem: effectiveStem, root });
        const isMeaningful = currentStem ? currentStem.length >= 6 : Boolean(effectiveStem);

        const matchesFingerprint = existingPre?.fingerprint
            ? Boolean(isMeaningful && existingPre.fingerprint === effectiveFp)
            : (!currentStem && !existingPre?.fingerprint);

        if (existingPre?.at && matchesFingerprint && (existingPre.conversationId === sessionId || !sessionId)) {
            emitHook(
                {
                    permission: 'allow',
                    esoPreflight: {
                        level: existingPre.level,
                        score: existingPre.score,
                        continuation: true,
                        cognitiveState: 'HOT',
                    },
                },
                shape,
            );
            return;
        }
    }

    /*
     * `event` is the kernel event the facade decides on — always `turn_start`. The host's own
     * event name travels in `kernelEvent`, which is what the route trace records. Swapping these
     * makes `decide` reject the turn with `unknown event_type`.
     */
    const turn = {
        event: 'turn_start',
        kernelEvent: 'prompt.submitted',
        turnId: requestId,
        userQueryStem: currentStem,
        fingerprint: currentFp,
        conversationId: sessionId,
        generationId,
        harnessTree: tree,
    };

    /*
     * The policy is passed explicitly, not re-derived from `profiles/generic-eso.json`. The
     * consumer's `.harness/decision-policy.json` already carries the profile defaults merged in
     * at provision time, so re-merging here would be a second, divergent source of thresholds.
     * It also means the host pack needs no copy of `profiles/` at runtime.
     *
     * What this call must add is the one fact the merge destroys: whether the consumer's own file
     * named `eso.sources` (G-01). `orchestrateTurn` turns the verdict into a source list, so the
     * ingest worker and this hook cannot disagree about which providers were asked for.
     */
    const { policy } = loadPolicyForCwd();
    const esoPolicy = {
        ...policy,
        eso: { ...policy.eso, sourcesDeclared: readDeclaredSources(root) },
    };

    let projection;
    const t0 = Date.now();
    try {
        const result = await orchestrateTurn(turn, { phase: 'preflight', cfg: { root }, policy: esoPolicy });
        if (result.skipped) {
            projection = { ok: true, skipped: true, reason: result.reason, at: new Date().toISOString() };
        } else {
            projection = buildPreflightProjection(turn, result, { latencyMs: Date.now() - t0, root, policy: esoPolicy });
        }
    } catch (err) {
        /*
         * COLLECT shells out to docgraph/codegraph. Those are the consumer's own tools, so a
         * failure here is a missing/broken adapter, not a missing product. Surface it instead of
         * pretending sufficiency was measured.
         */
        emitHook(
            {
                permission: 'allow',
                esoPreflightError: String(err?.message || err),
            },
            shape,
        );
        return;
    }

    try {
        if (projection) {
            projection.conversationId = sessionId;
            if (!projection.fingerprint && currentFp) projection.fingerprint = currentFp;
            /*
             * Remember what the corpus could not answer (G-13). Before this, every turn re-asked the same
             * term, got nothing, and reported it as a fresh gap — three atrievefin sessions in a row
             * carried an identical `law:*` set and nothing said it had been answered before.
             *
             * The non-answer is recorded, never the evidence: `lawMisses` comes from this turn's adapter
             * trace, and a term that answered this time is forgotten. A later turn whose stored list is
             * non-empty but whose fresh misses are empty has nothing to do here.
             */
            const answered = (projection.pack?.requiredDocTerms || []).filter(
                (t) => !(projection.lawMisses || []).includes(t),
            );
            const knownBefore = Object.keys(readLawMisses(root));
            const known = rememberLawMisses(root, projection.lawMisses, answered);
            const repeated = (projection.lawMisses || []).filter((t) => knownBefore.includes(t));
            if (repeated.length) projection.lawMissesKnown = repeated;
            projection.lawMisses = Object.keys(known);
        }
        writePreflightFile(root, tree, projection);
        /*
         * Merge, never reset (P-28). `beforeSubmitPrompt` runs on **every** submit, and a reset here
         * truncated the session's accumulated closure on each new prompt — `fineso` measured 32 closed
         * rows become 0 at the next refire. The merge keeps every id that is still required and records
         * the ones this preflight added as `reopenedBy: preflight-refire`.
         */
        mergeGapClosure(projection, root, tree);
        writeBundleStampFromPreflight(projection, esoPolicy, root, tree);
    } catch {
        /* fail-open on session file writes */
    }

    const out = {
        permission: 'allow',
        esoPreflight: {
            level: projection.level,
            score: projection.score,
            cognitiveState: projection.cognitiveState || 'COLD',
        },
    };

    // Cognitive Plane Dispatch:
    // WARM: Level is sufficient -> JIT-Pin verified Invariants (<= 30 tokens)
    // COLD / STALE: Level is insufficient -> emit structured Gap Directives
    if (projection.level === 'sufficient') {
        if (Array.isArray(projection.pinnedInvariants) && projection.pinnedInvariants.length > 0) {
            out.additional_context = `[ESO INVARIANTS PINNED] Active invariants for this turn:\n${projection.pinnedInvariants.map((id) => `• ${id}`).join('\n')}`;
        } else {
            out.additional_context = `[ESO SUFFICIENT] Evidence verified (score: ${Number(projection.score ?? 1).toFixed(2)}). All invariants satisfied.`;
        }
    } else {
        const stateLabel = projection.cognitiveState === 'STALE' ? 'STALE' : 'COLD';
        const block = buildEvidencePreflightBlock(projection);
        out.additional_context = `[ESO EVIDENCE GAP - ${stateLabel}] Score: ${Number(projection.score ?? 0).toFixed(2)}. Required before write:\n${block}`;
    }

    if (projection.ok === false && projection.enforceWrites === 'fail_closed') {
        out.permission = 'deny';
        out.user_message = denyReasonFor(projection);
        out.agent_message = out.user_message;
    }
    emitHook(out, shape);
}

/**
 * The deny, in the words of the verdict that produced it (G-12).
 *
 * This said "run gap fetch or narrow to a question" for every refusal — the same sentence for a turn that
 * never measured anything and a turn that measured everything its repo contains. It also never mentioned
 * that `fail_closed` can be a default the consumer did not write (G-08), or that a gap may be one no
 * reading can close (G-02), which are the two facts that decide what the operator does next.
 */
export function denyReasonFor(projection) {
    const parts = [
        `ESO preflight ${projection?.level ?? 'insufficient'} (score ${Number(projection?.score ?? 0).toFixed(2)}).`,
    ];
    const unanswerable = (projection?.unanswerableGaps || []).map((g) => g?.id).filter(Boolean);
    if (unanswerable.length) {
        parts.push(
            `These gaps cannot be closed by reading this repo — report them instead of retrying: ${unanswerable.join(', ')}.`,
        );
    }
    const open = (projection?.gaps || []).filter((g) => g?.unanswerable !== true);
    if (open.length) {
        parts.push(
            `Close the remaining gaps (${open
                .map((g) => `${g?.kind || 'gap'}:${g?.query || '?'}`)
                .join(', ')}) — read the files and re-run the query the preflight names.`,
        );
    }
    if (projection?.enforceWritesSource === 'default') {
        parts.push(
            '`enforceWrites` is NOT declared in .harness/decision-policy.json; the strict default `fail_closed` is in force. Setting `eso.mode` does not change it.',
        );
    }
    return parts.join(' ');
}

function writePreflightFile(root, tree, projection) {
    const dir = sessionDir(root, tree);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.eso-preflight.json'), `${JSON.stringify(projection, null, 2)}\n`);
}
