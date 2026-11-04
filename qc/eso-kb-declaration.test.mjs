import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import {
    initDeclarationSchema,
    resolveDeclarations,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-26 (DoD 5.1): DDL declaration table initializes and enforces BR-10 append-only trigger', () => {
    const db = new Database(':memory:');
    initDeclarationSchema(db);

    // Insert 2 records
    db.exec(`
        INSERT INTO declaration (project, kind, path, applies_when, content_hash, overrides, proposal_id, version, status)
        VALUES 
            ('p1', 'skill', 'skills/build.md', '{}', 'h1', '{}', NULL, '1.0', 'current'),
            ('p1', 'rule', 'rules/lint.md', '{}', 'h2', '{}', NULL, '1.1', 'superseded');
    `);

    const count = db.query('SELECT count(*) as total FROM declaration').get();
    assert.equal(count.total, 2);

    // Attempting DELETE is rejected by BR-10 trigger
    assert.throws(() => {
        db.exec("DELETE FROM declaration WHERE kind = 'rule'");
    }, (err) => {
        assert(err.message.includes('BR-10: declaration is append-only. DELETE is forbidden.'));
        return true;
    });

    // Count is strictly unchanged
    const countAfter = db.query('SELECT count(*) as total FROM declaration').get();
    assert.equal(countAfter.total, 2);
});

test('SCN-KB-27 (DoD 5.1): Three zones declare same id -> single winner, from records zone, overridden_by lists hidden', () => {
    const declarations = [
        {
            id: 'build-pipeline',
            kind: 'skill',
            path: 'skills/build.md',
            version: '3.0',
            zone: 'project',
            project: 'proj-k1',
            status: 'current',
        },
        {
            id: 'build-pipeline',
            kind: 'skill',
            path: 'skills/build.md',
            version: '2.0',
            zone: 'shared',
            status: 'current',
        },
        {
            id: 'build-pipeline',
            kind: 'skill',
            path: 'skills/build.md',
            version: '1.0',
            zone: 'pool',
            status: 'current',
        },
    ];

    const resolved = resolveDeclarations({
        project: 'proj-k1',
        declarations,
    });

    assert.equal(resolved.length, 1);
    const item = resolved[0];
    assert.equal(item.id, 'build-pipeline');
    assert.equal(item.version, '3.0');
    assert.equal(item.from, 'project');
    assert.deepEqual(item.overridden_by, [
        'shared/skills/build.md@2.0',
        'pool/skills/build.md@1.0',
    ]);
});

test('SCN-KB-28 (DoD 5.1): Shared item without project override wins over pool', () => {
    const declarations = [
        {
            id: 'security-scan',
            kind: 'rule',
            path: 'rules/scan.md',
            version: '1.2',
            zone: 'shared',
            status: 'current',
        },
        {
            id: 'security-scan',
            kind: 'rule',
            path: 'rules/scan.md',
            version: '1.0',
            zone: 'pool',
            status: 'current',
        },
    ];

    const resolved = resolveDeclarations({
        project: 'proj-k1',
        declarations,
    });

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].from, 'shared');
    assert.equal(resolved[0].version, '1.2');
    assert.deepEqual(resolved[0].overridden_by, ['pool/rules/scan.md@1.0']);
});

test('SCN-KB-29 (DoD 5.1): Resolved[] is strictly sorted by id codepoint for deterministic byte-identical replay', () => {
    const declarations = [
        { id: 'gamma', kind: 'skill', path: 's/g.md', zone: 'shared', status: 'current' },
        { id: 'alpha', kind: 'skill', path: 's/a.md', zone: 'shared', status: 'current' },
        { id: 'beta', kind: 'skill', path: 's/b.md', zone: 'shared', status: 'current' },
    ];

    const res1 = resolveDeclarations({ project: 'p-test', declarations });
    const res2 = resolveDeclarations({ project: 'p-test', declarations: [declarations[2], declarations[0], declarations[1]] });

    assert.deepEqual(res1.map(x => x.id), ['alpha', 'beta', 'gamma']);
    assert.equal(JSON.stringify(res1), JSON.stringify(res2));
});
