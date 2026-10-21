/**
 * DSH host shim.
 *
 * Today this is the provider layer only: the Cordis plugin (a later milestone) owns the DSH context
 * and passes host functions in. Keeping the providers dependency-free is what lets them be tested
 * without a running Harness.
 */
export { createDshSessionMemory } from './memory-provider.mjs';
export { createDshEsoPlugin } from './plugin.mjs';
export { createDshSkillsLaw, SKILL_ROOTS, INSTRUCTION_FILES } from './law-provider.mjs';
export { createEsoCordisPlugin, buildContextBlock } from './cordis.mjs';
export {
    buildDshBridgePatch,
    buildDshBundleManifest,
    renderBundleReadme,
    renderCordisPatchYaml,
    BRIDGE_PACKAGE,
    BRIDGE_ROW_ID,
} from './bridge.mjs';
