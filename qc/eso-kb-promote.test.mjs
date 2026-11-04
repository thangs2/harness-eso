import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    promoteToShared,
    revertSharedPromotion,
    resolveDeclarations,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-08 (AC-KB-03-01 & AC-KB-03-07): All projects without override adopt upgraded shared declaration', () => {
    const v12 = {
        id: 'skill-lint',
        kind: 'skill',
        path: 'skills/lint.md',
        version: '1.2',
        zone: 'shared',
        status: 'current',
    };

    const promo = promoteToShared({
        declaration: v12,
        new_version: '1.3',
        actor_role: 'operator',
        declarations: [v12],
        projects: ['proj-a', 'proj-b'],
    });

    assert.equal(promo.promoted, true);
    assert.deepEqual(promo.impact.affected_projects, ['proj-a', 'proj-b']);
    assert.deepEqual(promo.impact.overridden_projects, []);

    // Both projects resolve 1.3
    const resA = resolveDeclarations({ project: 'proj-a', declarations: promo.declarations });
    const resB = resolveDeclarations({ project: 'proj-b', declarations: promo.declarations });
    assert.equal(resA[0].version, '1.3');
    assert.equal(resB[0].version, '1.3');
});

test('SCN-KB-09 (AC-KB-03-02): Project with override does not change, surfaces overridden_by', () => {
    const sharedItem = {
        id: 'skill-config',
        kind: 'skill',
        path: 'skills/config.md',
        version: '1.0',
        zone: 'shared',
        status: 'current',
    };
    const localOverride = {
        id: 'skill-config',
        kind: 'skill',
        path: 'skills/config.md',
        version: '1.0-fork',
        zone: 'project',
        project: 'proj-pinned',
        status: 'current',
    };

    const promo = promoteToShared({
        declaration: sharedItem,
        new_version: '2.0',
        actor_role: 'operator',
        declarations: [sharedItem, localOverride],
        projects: ['proj-general', 'proj-pinned'],
    });

    assert.equal(promo.promoted, true);
    assert.deepEqual(promo.impact.affected_projects, ['proj-general']);
    assert.deepEqual(promo.impact.overridden_projects, ['proj-pinned']);

    const resPinned = resolveDeclarations({ project: 'proj-pinned', declarations: promo.declarations });
    assert.equal(resPinned[0].version, '1.0-fork');
    assert.equal(resPinned[0].from, 'project');
    assert.deepEqual(resPinned[0].overridden_by, ['shared/skills/config.md@2.0']);

    const resGeneral = resolveDeclarations({ project: 'proj-general', declarations: promo.declarations });
    assert.equal(resGeneral[0].version, '2.0');
    assert.equal(resGeneral[0].from, 'shared');
});

test('SCN-KB-10 (AC-KB-03-03): Promotion without human approval is rejected with APPROVAL_REQUIRED', () => {
    assert.throws(() => {
        promoteToShared({
            declaration: { id: 'skill-secret', version: '2.0' },
            actor_role: 'agent',
        });
    }, (err) => {
        assert.equal(err.code, 'APPROVAL_REQUIRED');
        return true;
    });

    assert.throws(() => {
        promoteToShared({
            declaration: { id: 'skill-secret', version: '2.0' },
            actor_role: undefined,
        });
    }, (err) => {
        assert.equal(err.code, 'APPROVAL_REQUIRED');
        return true;
    });
});

test('SCN-KB-11 (AC-KB-03-04): Impact returned and revert restores previous version pointer', () => {
    const v1 = { id: 'skill-audit', kind: 'skill', path: 's/a.md', version: '1.0', zone: 'shared', status: 'current' };
    const promo = promoteToShared({
        declaration: v1,
        new_version: '1.1',
        actor_role: 'operator',
        declarations: [v1],
        projects: ['proj-x'],
    });

    assert.equal(promo.promoted, true);
    assert.equal(promo.new_version, '1.1');

    const revert = revertSharedPromotion({
        item_id: 'skill-audit',
        actor_role: 'operator',
        declarations: promo.declarations,
    });

    assert.equal(revert.reverted, true);
    assert.equal(revert.revoked_version, '1.1');
    assert.equal(revert.restored_version, '1.0');

    const resolved = resolveDeclarations({ project: 'proj-x', declarations: revert.declarations });
    assert.equal(resolved[0].version, '1.0');
});

test('SCN-KB-23 (AC-KB-03-05 & ED6): Duplicate promotion with identical version/hash is no-op with impact: []', () => {
    const shared = {
        id: 'skill-idem',
        kind: 'skill',
        path: 's/i.md',
        version: '1.0',
        content_hash: 'hash-idem',
        zone: 'shared',
        status: 'current',
    };

    const promo = promoteToShared({
        declaration: shared,
        new_version: '1.0',
        content_hash: 'hash-idem',
        actor_role: 'operator',
        declarations: [shared],
        projects: ['p1'],
    });

    assert.equal(promo.promoted, false);
    assert.equal(promo.idempotent, true);
    assert.deepEqual(promo.impact, []);
});

test('SCN-KB-24 (AC-KB-03-06): Snapshot consistency across concurrent turns', () => {
    const initialDecls = [
        { id: 'skill-sync', kind: 'skill', path: 's/sync.md', version: '1.0', zone: 'shared', status: 'current' },
    ];

    const promo = promoteToShared({
        declaration: initialDecls[0],
        new_version: '2.0',
        actor_role: 'operator',
        declarations: initialDecls,
        projects: ['p1'],
    });

    // Older snapshot turn strictly resolves 1.0
    const snapshotA = resolveDeclarations({ project: 'p1', declarations: initialDecls });
    assert.equal(snapshotA[0].version, '1.0');

    // Newer snapshot turn strictly resolves 2.0
    const snapshotB = resolveDeclarations({ project: 'p1', declarations: promo.declarations });
    assert.equal(snapshotB[0].version, '2.0');
});
