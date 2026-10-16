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
import { findRepoRoot } from '@mu/harness-foundation/pure';
import { detectShape, emitHook, harnessTree, loadPolicyForCwd, readStdin, sessionDir } from './hook-io.mjs';
import { readGapClosure, readPreflight, resetGapClosure, writeBundleStampFromPreflight } from './eso-gap-io.mjs';

function buildEvidencePreflightBlock(pre) {
    if (!pre) return '';
    const parts = [];
    parts.push(`ESO preflight: ${pre.level} (score ${Number(pre.score ?? 0).toFixed(2)}).`);
    if (Array.isArray(pre.gaps) && pre.gaps.length) {
        parts.push(`Gaps: ${pre.gaps.map((g) => g.kind || g.query || 'gap').join(', ')}.`);
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

    // Antigravity fires PreInvocation before EVERY LLM call (invocationNum: 0, 1, 2...).
    // For continuation steps (invocationNum > 0) in the same session, do not wipe gap closure!
    if (shape === 'antigravity' && typeof data.invocationNum === 'number' && data.invocationNum > 0) {
        const existingPre = readPreflight(root, tree);
        if (existingPre?.at && (existingPre.conversationId === sessionId || !sessionId)) {
            emitHook(
                {
                    permission: 'allow',
                    esoPreflight: { level: existingPre.level, score: existingPre.score, continuation: true },
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
        userQueryStem: stemFromPrompt(data),
        conversationId: sessionId,
        generationId,
        harnessTree: tree,
    };

    /*
     * The policy is passed explicitly, not re-derived from `profiles/generic-eso.json`. The
     * consumer's `.harness/decision-policy.json` already carries the profile defaults merged in
     * at provision time, so re-merging here would be a second, divergent source of thresholds.
     * It also means the host pack needs no copy of `profiles/` at runtime.
     */
    const { policy } = loadPolicyForCwd();

    let projection;
    const t0 = Date.now();
    try {
        const result = await orchestrateTurn(turn, { phase: 'preflight', cfg: { root }, policy });
        if (result.skipped) {
            projection = { ok: true, skipped: true, reason: result.reason, at: new Date().toISOString() };
        } else {
            projection = buildPreflightProjection(turn, result, { latencyMs: Date.now() - t0 });
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
        if (projection) projection.conversationId = sessionId;
        writePreflightFile(root, tree, projection);
        resetGapClosure(projection.at, root, tree);
        writeBundleStampFromPreflight(projection, policy, root, tree);
    } catch {
        /* fail-open on session file writes */
    }

    const out = {
        permission: 'allow',
        esoPreflight: { level: projection.level, score: projection.score },
    };
    const block = buildEvidencePreflightBlock(projection);
    if (block && projection.level !== 'sufficient') {
        out.additional_context = `[ESO COGNITION] Evidence sufficiency notice: For code/implementation, close gaps before code generation. For docs/analysis/planning, Brain deep-thinking is permitted immediately; close gaps before protected writes.\n\n${block}`;
    }
    if (projection.ok === false && projection.enforceWrites === 'fail_closed') {
        out.permission = 'deny';
        out.user_message =
            'ESO preflight insufficient for dev slice — run gap fetch or narrow to a question.';
        out.agent_message = out.user_message;
    }
    emitHook(out, shape);
}

function writePreflightFile(root, tree, projection) {
    const dir = sessionDir(root, tree);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.eso-preflight.json'), `${JSON.stringify(projection, null, 2)}\n`);
}
