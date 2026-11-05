import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPgDb } from './helpers/test-pg-db.mjs';
import {
    initDeclarationSchema,
    resolveDeclarations,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-26 (DoD 5.1): DDL declaration table initializes and enforces BR-10 append-only trigger', async () => {
    const pg = await createTestPgDb();
    const db = pg.db;
    try {
        await initDeclarationSchema(db);
        await db.exec(`
            INSERT INTO declaration (project, kind, path, applies_when, content_hash, overrides, proposal_id, version, status)
            VALUES
                ('p1', 'skill', 'skills/build.md', '{}', 'h1', '{}', NULL, '1.0', 'current'),
                ('p1', 'rule', 'rules/lint.md', '{}', 'h2', '{}', NULL, '1.1', 'superseded')
        `);
        const count = await db.get('SELECT count(*)::int AS total FROM declaration');
        assert.equal(count.total, 2);

        await assert.rejects(
            () => db.exec("DELETE FROM declaration WHERE kind = 'rule'"),
            (err) => err.message.includes('BR-10: declaration is append-only. DELETE is forbidden.')
        );
        const countAfter = await db.get('SELECT count(*)::int AS total FROM declaration');
        assert.equal(countAfter.total, 2);
    } finally {
        await pg.cleanup();
    }
});

test('SCN-KB-27 (DoD 5.1): Three zones declare same id -> single winner, from records zone, overridden_by lists hidden', () => {
    const declarations = [
        { id: 'build-pipeline', kind: 'skill', path: 'skills/build.md', version: '3.0', zone: 'project', project: 'proj-k1', status: 'current' },
        { id: 'build-pipeline', kind: 'skill', path: 'skills/build.md', version: '2.0', zone: 'shared', status: 'current' },
        { id: 'build-pipeline', kind: 'skill', path: 'skills/build.md', version: '1.0', zone: 'pool', status: 'current' },
    ];
    const resolved = resolveDeclarations({ project: 'proj-k1', declarations });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].version, '3.0');
    assert.equal(resolved[0].from, 'project');
    assert.deepEqual(resolved[0].overridden_by, ['shared/skills/build.md@2.0', 'pool/skills/build.md@1.0']);
});
