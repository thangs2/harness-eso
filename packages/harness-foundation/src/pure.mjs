/**
 * Pure subset of the foundation — repo anchor, `.harness` paths, policy load.
 *
 * The host pack bundles this subset and never the package root. `src/index.mjs` also re-exports
 * the SQLite port and the workspace/provision layers; importing it from a hook drags a database
 * driver into every tool-call closure, and with it a conditional `bun:sqlite` import that no
 * consumer can resolve when the hook runs under plain `node`.
 *
 * Keep this file free of `node:child_process`, `bun:*` and any filesystem-writing module: every
 * symbol added here is bundled into the pack and executed on every guarded tool call.
 */
export { CONFIG_NAME, expandHome, findConfigPath, findRepoRoot, isoNow } from './repo-root.mjs';
export {
    RUNTIME_DIR,
    RUNTIME_FILES,
    decisionPolicyFile,
    harnessDbFile,
    harnessDir,
    sessionDir,
} from './paths.mjs';
export { DEFAULT_POLICY, loadDecisionPolicy, loadDecisionPolicyForCwd } from './policy-load.mjs';
/*
 * Shell write detection. Lives here, not in the observe server, because the **host pack** needs it
 * too: the pack's `shell-targets` hook is what the consumer's shell guard calls to find out which
 * files a command writes. Putting it in the observe server would have forced a second copy, and two
 * copies of a heuristic is exactly what let the Shell write channel go unnoticed.
 *
 * Pure string work — no filesystem, no child process — so it is safe on the pack's hot path.
 */
export { shellCommandOf, shellHasWriteIntent, shellWriteTargets } from './shell-writes.mjs';
export {
    DEFAULT_PATH_POLICY,
    isSotPath,
    pathMode,
    resolvePathPolicy,
    toRepoRelative,
} from './path-policy.mjs';

/*
 * Consent records. The **read** side is exported here because the pack and the observer may need to
 * answer "is this path approved?"; the write side is deliberately not, so nothing on the hot path can
 * acquire the ability to grant consent by importing it.
 */
export { CONSENT_DIR_NAME, consentCovers, consentDir, consentFile, liveConsents, readConsentStore } from './consent.mjs';

/*
 * Attestations. Exported from `pure` because the pack's preflight hook is a writer: it records the
 * evidence verdict where the guard can read it and the agent's own Write/Shell path cannot.
 */
export {
    ATTEST_MAX_AGE_SECONDS,
    BRAIN_ROLES,
    attestDir,
    brainAttested,
    computeReceiptMac,
    computeRepoState,
    esoAttestationFile,
    getAttestationSecret,
    projectIdFrom,
    readEsoAttestation,
    repoStateChanged,
    usageLedgerFile,
    verifySufficiencyReceipt,
    writeEsoAttestation,
} from './attest.mjs';

export {
    computeFastFingerprint,
    normalizeStem,
    readGitHead,
    readIndexMtime,
} from './fingerprint.mjs';

