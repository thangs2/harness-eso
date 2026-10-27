/**
 * The ESO evidence attestation, written by the DSH plugin.
 *
 * Why this module exists: `guard-write.py`'s evidence gate prefers `<product-state>/attest/<pid>.json`
 * over the session stamp, and **nothing on DSH ever wrote it**. Preflight on Cursor and Antigravity runs
 * as a command hook; DSH has no command hooks, so its guard read no attestation at all and — with
 * `enforceWrites: fail_closed` — refused every protected write *before* the Brain gate was consulted.
 * The observe log then showed the denial as an evidence failure with no evidence, which reads like a
 * policy problem and was in fact a missing writer.
 *
 * Why the plugin and not the hook pack: the attestation only means something if the process writing it
 * runs outside the agent's Write/Shell path. The plugin's `agent/pre-step` handler does — it is the host
 * calling us, not the agent asking. That is the same trust status the pack's preflight hook has on the
 * other two hosts, which is why this writes the same document through the same function.
 *
 * What this does **not** claim: the verdict here is built from the consumer's declared `eso.checks`
 * (named findings), not from a docgraph/codegraph sufficiency measurement. Those adapters are MCP
 * servers bound to the other hosts' tool sets. So a DSH attestation says "the checks the consumer
 * declared produced no blocker", which is a weaker statement than Cursor's score — and it is stated in
 * the `source` field rather than left for a reader to assume.
 */
import {
    projectIdFrom,
    readEsoAttestation,
    writeEsoAttestation,
} from '@mu/harness-foundation/pure';

/** Marks an attestation this plugin minted, so a reader can tell it from the pack's measurement. */
export const DSH_ATTESTATION_SOURCE = 'dsh-plugin-checks';

/**
 * The evidence level a check-only verdict implies.
 *
 * `partial` is deliberate, not cautiousness: no source-set measurement happened, so claiming
 * `sufficient` would attest more than was observed. A consumer that sets `jevOnPartial` will still
 * publish nothing on `partial` — that is its policy, and this module must not pretend around it.
 */
const CHECK_ONLY_LEVEL = 'partial';

/**
 * Write (or refresh) the attestation for one consumer after its checks ran.
 *
 * Never throws. A gate that cannot write its receipt must not take the host's step down with it: the
 * caller is a `pre-step` handler, and the guard's behaviour without an attestation is the well-defined
 * one it had before this existed (fall back to the session stamp, then deny).
 *
 * @param {{
 *   root: string,
 *   policy?: object,
 *   blockers?: object[],
 *   errors?: string[],
 *   at?: string,
 * }} input
 * @returns {{ written: boolean, file?: string, reason?: string, doc?: object }}
 */
export function writeDshAttestation({ root, policy = {}, blockers = [], errors = [], at = null } = {}) {
    try {
        if (!root) return { written: false, reason: 'no consumer root' };
        const projectId = projectIdFrom(root);
        if (!projectId) return { written: false, reason: 'consumer has no project id' };

        /*
         * A hard blocker is evidence that the tree is NOT ready. Attesting `allowWrite: true` anyway
         * would make the guard's preferred path disagree with the gate that just rejected the step, and
         * the write would then be admitted on the strength of a check that failed.
         */
        const allowWrite = blockers.length === 0 && errors.length === 0;

        const enforceWrites = policy?.eso?.enforceWrites ?? null;
        const mode = policy?.eso?.mode ?? null;
        const doc = writeEsoAttestation(projectId, {
            at: at || undefined,
            level: allowWrite ? CHECK_ONLY_LEVEL : 'insufficient',
            score: null,
            allowWrite,
            enforceWrites,
            mode,
            /*
             * `repoState` is left null on purpose. The pack compares git-index and policy mtimes to
             * decide whether a verdict still describes the tree on disk (G-21). This plugin has no
             * measurement to invalidate that way — it re-runs the checks on every step — and inventing
             * a `repoState` here would either freeze a stale verdict or expire a fresh one.
             */
            repoState: null,
            ttlSec: 600,
            source: DSH_ATTESTATION_SOURCE,
        });
        return { written: true, file: `${projectId}.json`, doc };
    } catch (err) {
        return { written: false, reason: err?.message ?? String(err) };
    }
}

/**
 * Does the receipt already on disk say what this step measured?
 *
 * The plugin must not rewrite the same document on every step — a write to product state per step
 * pollutes the audit trail and makes "when did the verdict change" unanswerable. But it must also not
 * skip a write that would *change* the answer, and the obvious version of this function got that wrong:
 * checking "is there a receipt with `allowWrite: true`" skipped the write exactly when a check had just
 * started failing, so the guard kept reading the previous `allowWrite: true` and admitted a write the
 * current step had blocked. A gate that reports a failure and then permits the write is worse than no
 * attestation at all.
 *
 * So the comparison is on the verdict, not on the file: same provenance, same `allowWrite`. A receipt
 * minted by the pack (Cursor/Antigravity) is never overwritten from here — its `repoState` and `score`
 * come from a real measurement this plugin cannot reproduce, and replacing it with a check-only verdict
 * would weaken a stronger receipt.
 *
 * @param {string} root
 * @param {{ allowWrite: boolean }} verdict
 * @returns {boolean}
 */
export function receiptMatchesVerdict(root, verdict) {
    try {
        const projectId = projectIdFrom(root);
        if (!projectId) return false;
        const doc = readEsoAttestation(projectId);
        if (!doc || doc.ok !== true) return false;
        // `source` is how a receipt says who minted it. An older pack does not write it, so an absent
        // value means "the pack" — the conservative reading, since we must not clobber it.
        if (doc.source !== DSH_ATTESTATION_SOURCE) return false;
        return doc.allowWrite === verdict.allowWrite;
    } catch {
        return false;
    }
}
