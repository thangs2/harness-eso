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
