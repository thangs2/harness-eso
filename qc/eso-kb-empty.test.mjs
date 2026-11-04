import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveKnowledge } from '../eso/knowledge/src/index.mjs';

test('SCN-KB-19 (AC-KB-01-04): Project with 0 declarations resolves to empty set without error', () => {
    // Zero declarations provided
    const emptyResult = resolveEffectiveKnowledge('brand-new-project', []);

    assert.deepEqual(emptyResult.items, []);
    assert.equal(emptyResult.errors.length, 0);
    assert.equal(emptyResult.warnings.length, 0);
});
