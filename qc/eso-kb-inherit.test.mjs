import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveKnowledge, queryKnowledgeItem } from '../eso/knowledge/src/index.mjs';

test('SCN-KB-03 (AC-KB-01-03): Items in shared pool appear across both projects without breaking isolation', () => {
    const declarations = [
        { id: 'shared-rule-101', zone: 'shared', content: 'Global coding guideline' },
        { id: 'projA-private', project: 'project-A', zone: 'project', content: 'Internal A' },
        { id: 'projB-private', project: 'project-B', zone: 'project', content: 'Internal B' }
    ];

    // Query from Project A
    const queryA = queryKnowledgeItem('project-A', 'shared-rule-101', declarations);
    assert.equal(queryA.found, true);
    assert.equal(queryA.item.resolvedFrom, 'shared');

    // Query from Project B
    const queryB = queryKnowledgeItem('project-B', 'shared-rule-101', declarations);
    assert.equal(queryB.found, true);
    assert.equal(queryB.item.resolvedFrom, 'shared');

    // Resolution set across both projects
    const setA = resolveEffectiveKnowledge('project-A', declarations);
    const setB = resolveEffectiveKnowledge('project-B', declarations);

    assert.ok(setA.items.some(i => i.id === 'shared-rule-101' && i.from === 'shared'));
    assert.ok(setB.items.some(i => i.id === 'shared-rule-101' && i.from === 'shared'));

    // Cross-project privacy is maintained while sharing global
    assert.ok(!setA.items.some(i => i.id === 'projB-private'));
    assert.ok(!setB.items.some(i => i.id === 'projA-private'));
});
