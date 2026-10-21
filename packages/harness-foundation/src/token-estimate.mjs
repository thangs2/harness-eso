/**
 * The one token heuristic, split out of `token-diet.mjs`.
 *
 * Why a separate module: the host pack bundles every module reachable from the core barrel, and
 * `surface-check` needs this estimate on a path that ships inside the pack. Importing `token-diet`
 * for it dragged the whole scanner (frontmatter, rule discovery, globs) into every hook call for a
 * one-line division. `token-diet` re-exports this, so there is still exactly one definition (A1).
 */

/**
 * Estimate token count for markdown / code.
 * Uses ~3.8 characters per token heuristic (cl100k-compatible approximation).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.8);
}
