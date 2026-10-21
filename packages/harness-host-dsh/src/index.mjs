/**
 * DSH host shim.
 *
 * The provider layer is dependency-free so it can be tested without a running Harness. The Cordis
 * entry is a thin translation over the real 0.2.1 surface (`agent/pre-step`, `(payload, next)`,
 * `{ kind: 'reject' }`); enforcement stays in the hooks bridge, not here.
 */
export { createDshSessionMemory } from './memory-provider.mjs';
export { createDshEsoPlugin } from './plugin.mjs';
export { createDshSkillsLaw, SKILL_ROOTS, INSTRUCTION_FILES } from './law-provider.mjs';
export {
    createEsoCordisPlugin,
    buildContextBlock,
    CORDIS_PRE_STEP,
    INSTRUCTIONS_SOURCE,
} from './cordis.mjs';
export {
    buildDshBridgePatch,
    buildDshBundleManifest,
    renderBundleReadme,
    renderCordisPatchYaml,
    BRIDGE_PACKAGE,
    BRIDGE_ROW_ID,
} from './bridge.mjs';
