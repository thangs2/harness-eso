import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_POLICY } from '../packages/harness-foundation/src/policy-load.mjs';
import { applyRecipe, listRecipes, loadRecipe, mergePolicy, validateRecipe } from '../packages/harness-eso-core/src/recipe.mjs';

const RECIPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles', 'recipes');

test('arrays replace instead of concatenating', () => {
    /*
     * A provider chain is an ordered decision. Merging two orders produces an order nobody wrote, so
     * `prefer`/`fallback` must be replaced wholesale.
     */
    const base = { eso: { sources: { memory: { prefer: ['native'], fallback: ['none'] } } } };
    const out = mergePolicy(base, { eso: { sources: { memory: { prefer: ['agentmemory-mcp'] } } } });
    assert.deepEqual(out.eso.sources.memory.prefer, ['agentmemory-mcp']);
    assert.deepEqual(out.eso.sources.memory.fallback, ['none'], 'untouched keys survive');
});

test('the shipped recipes parse and apply', () => {
    const recipes = listRecipes(RECIPES);
    assert.deepEqual(recipes.map((r) => r.id).sort(), ['dsh-native', 'lite', 'pro']);

    const pro = applyRecipe(DEFAULT_POLICY, loadRecipe(RECIPES, 'pro'));
    assert.equal(pro.eso.sources.memory.adapter, 'agentmemory-mcp');

    const lite = applyRecipe(DEFAULT_POLICY, loadRecipe(RECIPES, 'lite'));
    assert.equal(lite.eso.sources.law.enabled, false);

    const dsh = applyRecipe(DEFAULT_POLICY, loadRecipe(RECIPES, 'dsh-native'));
    assert.deepEqual(dsh.eso.sources.memory.prefer, ['native']);
    assert.deepEqual(dsh.eso.sources.memory.fallback, ['agentmemory-mcp', 'none']);
});

test('a recipe with the wrong version is rejected, not silently applied', () => {
    assert.throws(() => validateRecipe({ version: 2, id: 'x', policyPatch: {} }), /unsupported version/);
    assert.throws(() => validateRecipe({ version: 1, policyPatch: {} }), /missing id/);
});

test('an unknown recipe id fails with the path it tried', () => {
    assert.throws(() => loadRecipe(RECIPES, 'nope'), /recipe not found/);
    assert.throws(() => loadRecipe(RECIPES, '../etc/passwd'), /invalid recipe id/);
});
