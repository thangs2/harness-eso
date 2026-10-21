/**
 * Recipes — a named binding of ports to providers (RFC 18 §3.7).
 *
 * A policy says what is *allowed*; a recipe says what this consumer *prefers* for a given kind of
 * work. Keeping them separate is what lets the same engine run `lite` on a laptop and `pro` on a
 * regulated repository without editing the consumer's decision policy by hand.
 *
 * A recipe is data:
 *   { "version": 1, "id": "lite", "description": "...", "policyPatch": { "eso": { ... } } }
 *
 * `policyPatch` is merged over the consumer policy. Objects merge; arrays REPLACE. Replacing is the
 * point: a provider chain (`prefer`) is an ordered decision, and merging two orders produces an
 * order nobody wrote.
 */
import fs from 'node:fs';
import path from 'node:path';

export const RECIPE_VERSION = 1;

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

export function validateRecipe(recipe, label = 'recipe') {
    assertObject(recipe, label);
    if (recipe.version !== RECIPE_VERSION) {
        throw new Error(`${label}: unsupported version ${recipe.version} (expected ${RECIPE_VERSION})`);
    }
    if (typeof recipe.id !== 'string' || !recipe.id.trim()) throw new Error(`${label}: missing id`);
    assertObject(recipe.policyPatch ?? {}, `${label}.policyPatch`);
    return recipe;
}

/** Objects merge; arrays and scalars from `patch` replace the base value. */
export function mergePolicy(base, patch) {
    if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergePolicy(out[key], value) : value;
    }
    return out;
}

/**
 * @param {object} policy full decision policy
 * @param {object} recipe validated recipe
 */
export function applyRecipe(policy, recipe) {
    validateRecipe(recipe);
    return mergePolicy(policy, recipe.policyPatch ?? {});
}

/** Read one recipe by id from a directory of `<id>.json` files. */
export function loadRecipe(dir, id) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id ?? ''))) throw new Error(`invalid recipe id: ${id}`);
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`recipe not found: ${file}`);
    return validateRecipe(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** All recipes in a directory, sorted by id. A malformed file fails loudly rather than being skipped. */
export function listRecipes(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => loadRecipe(dir, name.replace(/\.json$/, '')));
}
