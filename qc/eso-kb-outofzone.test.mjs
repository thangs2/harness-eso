import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveKnowledge, validateDeclarationZone } from '../eso/knowledge/src/index.mjs';

test('SCN-KB-20 (AC-KB-01-05): Declaration outside declared zone is skipped with OUT_OF_ZONE warning', () => {
    const validProjectDecl = {
        id: 'decl-valid',
        project: 'project-corp',
        zone: 'project',
        path: 'project/rules/corp.md'
    };

    const outOfZoneDecl = {
        id: 'decl-intruder',
        project: 'project-corp',
        zone: 'project',
        path: 'shared/rules/intruder.md'
    };

    const pathTraversalDecl = {
        id: 'decl-traverse',
        project: 'project-corp',
        zone: 'project',
        path: '../../etc/shadow'
    };

    // Direct validation check
    const validCheck = validateDeclarationZone(validProjectDecl, 'project');
    assert.equal(validCheck.valid, true);

    const outCheck = validateDeclarationZone(outOfZoneDecl, 'project');
    assert.equal(outCheck.valid, false);
    assert.equal(outCheck.code, 'OUT_OF_ZONE');
    assert.equal(outCheck.path, 'shared/rules/intruder.md');

    const traverseCheck = validateDeclarationZone(pathTraversalDecl, 'project');
    assert.equal(traverseCheck.valid, false);
    assert.equal(traverseCheck.code, 'OUT_OF_ZONE');

    // Resolution skipping
    const result = resolveEffectiveKnowledge('project-corp', [validProjectDecl, outOfZoneDecl, pathTraversalDecl]);

    // Only valid item loaded, 0 foreign files loaded
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'decl-valid');

    // 2 warnings logged for out of zone declarations
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some(w => w.code === 'OUT_OF_ZONE' && w.path === 'shared/rules/intruder.md'));
    assert.ok(result.warnings.some(w => w.code === 'OUT_OF_ZONE' && w.path === '../../etc/shadow'));
});
