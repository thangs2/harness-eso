/**
 * DSH host shim.
 *
 * Today this is the provider layer only: the Cordis plugin (a later milestone) owns the DSH context
 * and passes host functions in. Keeping the providers dependency-free is what lets them be tested
 * without a running Harness.
 */
export { createDshSessionMemory } from './memory-provider.mjs';
