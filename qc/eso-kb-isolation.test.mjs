import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveKnowledge } from '../eso/knowledge/src/index.mjs';

test('SCN-KB-01 (AC-KB-01-01): 2 project in one instance resolve disjoint effective sets', () => {
    const declarations = [
        { id: 'item-A1', project: 'project-alpha', zone: 'project', content: 'knowledge-alpha-1' },
        { id: 'item-A2', project: 'project-alpha', zone: 'project', content: 'knowledge-alpha-2' },
        { id: 'item-B1', project: 'project-beta', zone: 'project', content: 'knowledge-beta-1' }
    ];

    const resultAlpha = resolveEffectiveKnowledge('project-alpha', declarations);
    const resultBeta = resolveEffectiveKnowledge('project-beta', declarations);

    // Alpha gets only alpha items
    assert.equal(resultAlpha.items.length, 2);
    assert.deepEqual(resultAlpha.items.map(i => i.id).sort(), ['item-A1', 'item-A2']);
    assert.equal(resultAlpha.items.some(i => i.project === 'project-beta'), false);

    // Beta gets only beta items
    assert.equal(resultBeta.items.length, 1);
    assert.equal(resultBeta.items[0].id, 'item-B1');
    assert.equal(resultBeta.items.some(i => i.project === 'project-alpha'), false);
});
