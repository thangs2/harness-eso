/**
 * Brain evidence on DSH — the plugin witnesses the model call itself.
 *
 * ## Why the ledger is the wrong source here
 *
 * `guard-write.py`'s primary Brain evidence is the DeepSeek usage ledger, and on Cursor/Antigravity that
 * is the right choice: the MCP server writes it from a process the agent cannot reach, and the hook only
 * reads it. DSH breaks that arrangement in a way no amount of configuration repairs — its sandbox gives
 * the MCP **child process** no write access to product state, so the ledger silently never gains the row.
 * Measured: `usage ledger write failed: EPERM`, last record three days stale, while the guard reported
 * "no Brain call" for calls that had in fact completed.
 *
 * Moving the ledger somewhere writable was the tempting fix and it is the wrong one: anywhere the MCP
 * child can write inside a workspace, the agent can write too, and a ledger the agent can append to is a
 * ledger the agent can forge — the exact defect `attest.mjs` records from an earlier incident.
 *
 * ## What replaces it
 *
 * The plugin is standing inside the tool pipeline. `tools/post-execute` hands it the tool name, the
 * arguments and the result, so it can observe a Brain-tier call **that actually returned**, in-process,
 * without reading any file. That is a strictly better witness than the ledger: the ledger says "a Brain
 * call happened somewhere on this machine recently"; this says "this session's Brain tool returned
 * successfully just now".
 *
 * ## Trust boundary
 *
 * This must not be forgeable by the agent being gated. Two properties carry that:
 *
 *   - The evidence is written from a **host pipeline listener**, not from a tool the agent can call. The
 *     agent's Write/Shell path does not reach product state (both guards deny it), and it cannot emit a
 *     `tools/post-execute`.
 *   - Only a **result that is not an error** counts. A Brain tool that failed, timed out or was cancelled
 *     attests nothing — otherwise a retry storm would satisfy the gate for free.
 *
 * A model call is not replayable either: `ask_deepseek_pro` costs real tokens and real time. Where the
 * ledger was machine-wide and loose (any project's call satisfied any project's gate), this is
 * per-session and tight.
 */
import { projectIdFrom } from '@mu/harness-foundation/pure';

/**
 * Tools that count as a Brain call, as DSH namespaces them (`mcp__<serverName>__<rawName>`).
 *
 * `ask_deepseek` is here because the server routes it by prompt complexity, so the operator cannot tell it
 * apart from the Brain path — `brain-dispatch` in the hook pack reads the same three.
 *
 * `ask_deepseek_flash` is **not**. It is the cheap tier, and it exists precisely so work can proceed
 * without a Brain call; counting it would make the gate free to satisfy. The first version of this module
 * listed it, and a test caught the gate opening for a call that costs a fraction of a Brain call — which
 * is the shape of every "the gate was accidentially decorative" defect in this repo.
 */
export const BRAIN_TOOLS = new Set([
    'mcp__deepseek-direct__ask_deepseek',
    'mcp__deepseek-direct__ask_deepseek_pro',
]);

/**
 * Did this post-execute view describe a completed Brain call?
 *
 * @param {{ name?: string, args?: object }} exec
 * @param {{ isError?: boolean }} result
 * @returns {boolean}
 */
export function isCompletedBrainCall(exec, result) {
    if (!BRAIN_TOOLS.has(String(exec?.name ?? ''))) return false;
    // Only a non-error result. A failed call is the one case where "the tools ran" must not be read as
    // "the agent reasoned".
    return result?.isError !== true;
}

/**
 * The Brain evidence record the guard reads, in the shape `brain_attested()` expects.
 *
 * `guard-write.py` reads `<product-state>/attest/<pid>.json` for the evidence verdict and the DeepSeek
 * ledger for the Brain call. The two are separate files on the other hosts. On DSH they are one
 * document, because the plugin is the witness for both — see `writeDshAttestation`.
 *
 * The `at` is the moment the tool returned, not the moment the step started: the gate's window is "how
 * long ago did reasoning finish", and a 600-second `ask_deepseek_pro` would otherwise be born stale.
 *
 * @param {{ role?: string, model?: string }} [meta]
 * @returns {{ ok: true, via: string, at: string, brainTier: string, tool: string }}
 */
export function brainRecordFor(toolName, meta = {}) {
    const raw = String(toolName).replace(/^mcp__deepseek-direct__/, '');
    return {
        ok: true,
        via: 'dsh-plugin',
        at: new Date().toISOString(),
        brainTier: raw,
        tool: String(toolName),
        ...(meta.role ? { role: meta.role } : {}),
        ...(meta.model ? { model: meta.model } : {}),
    };
}

/**
 * Attest one completed Brain call for this consumer.
 *
 * Writes the same `<product-state>/attest/<pid>.json` that `guard-write.py` already prefers, so the
 * guard needs no new read path and no new file format. The verdict fields it needs (`level`,
 * `allowWrite`) are **left to the evidence writer** — this function only stamps the Brain half, and a
 * call that sets `allowWrite` here would let a model call substitute for evidence sufficiency, which are
 * two different questions.
 *
 * @param {{ root: string, tool: string, at?: string, writeEsoAttestation: Function, readEsoAttestation: Function }} input
 * @returns {{ written: boolean, reason?: string }}
 */
export function recordBrainCall({ root, tool, writeEsoAttestation, readEsoAttestation }) {
    try {
        if (!root) return { written: false, reason: 'no consumer root' };
        const projectId = projectIdFrom(root);
        if (!projectId) return { written: false, reason: 'consumer has no project id' };

        /*
         * Re-mint from the **existing** document rather than from defaults. Rewriting with defaults would
         * silently reset `allowWrite`/`level` to whatever this call happened to pass, so a Brain call
         * could wipe an evidence refusal — the two gates must stay independent.
         */
        const previous = readEsoAttestation(projectId) ?? {};
        const doc = writeEsoAttestation(projectId, {
            at: previous.at || undefined,
            level: previous.level ?? 'unknown',
            score: previous.score ?? null,
            allowWrite: previous.allowWrite === true,
            enforceWrites: previous.enforceWrites ?? null,
            mode: previous.mode ?? null,
            enforceWritesSource: previous.enforceWritesSource ?? 'declared',
            unanswerableGaps: previous.unanswerableGaps ?? [],
            deferWrite: previous.deferWrite ?? { paths: [], mode: 'evidence' },
            jevOnPartial: previous.jevOnPartial === true,
            repoState: previous.repoState ?? null,
            ttlSec: previous.ttlSec ?? 600,
            source: previous.source ?? 'dsh-plugin-checks',
            brain: brainRecordFor(tool),
        });
        return { written: true, doc };
    } catch (err) {
        return { written: false, reason: err?.message ?? String(err) };
    }
}
