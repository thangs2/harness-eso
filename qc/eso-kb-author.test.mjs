import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateDeclarationFormat,
    checkDanglingOverrides,
    saveDeclaration,
    computeDeclarationHash,
    ALLOWED_DECLARATION_FIELDS,
    ALLOWED_APPLIES_WHEN_FIELDS,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-12 (AC-KB-04-01): Valid declaration with closed attributes saves successfully and increments version', () => {
    const decl = {
        id: 'rule-auth-v2',
        version: '1.2.0',
        kind: 'rule',
        applies_when: { always: true },
        declared_by: 'alice',
        declared_at: '2026-11-04T00:00:00Z',
        path: 'rules/auth.md',
        content: 'JWT verification is mandatory',
        content_hash: computeDeclarationHash('JWT verification is mandatory'),
        zone: 'project',
        project: 'p-alpha',
    };

    const prevDecl = {
        id: 'rule-auth-v2',
        version: '1.1.0',
        content: 'Old auth rule',
        content_hash: computeDeclarationHash('Old auth rule'),
    };

    const result = saveDeclaration({
        declaration: decl,
        previousDeclaration: prevDecl,
    });

    assert.equal(result.saved, true);
    assert.equal(result.declaration.status, 'current');
    assert.equal(result.declaration.version, '1.2.0');
    assert.equal(result.warnings.length, 0);
});

test('SCN-KB-13 (AC-KB-04-02): Declaration with unknown top-level or applies_when attribute rejected with UNKNOWN_ATTRIBUTE (0 writes)', () => {
    // 1. Unknown top-level attribute
    const declBadTop = {
        id: 'rule-unknown-attr',
        version: '1.0.0',
        kind: 'rule',
        author_notes: 'not a standard field',
        content: 'Test content',
    };

    assert.throws(() => {
        saveDeclaration({ declaration: declBadTop });
    }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
        assert.equal(err.field, 'author_notes');
        return true;
    });

    // 2. Unknown field in applies_when
    const declBadAw = {
        id: 'rule-unknown-aw',
        version: '1.0.0',
        kind: 'rule',
        applies_when: { custom_filter: 123 },
        content: 'Test content',
    };

    assert.throws(() => {
        saveDeclaration({ declaration: declBadAw });
    }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
        assert.equal(err.field, 'applies_when.custom_filter');
        return true;
    });
});

test('SCN-KB-14 (AC-KB-04-03): Required attribute in applies_when undeclared by project triggers warning and no default', () => {
    const decl = {
        id: 'rule-tenant-check',
        version: '1.0.0',
        kind: 'rule',
        applies_when: {
            tenant_model: 'multi_tenant',
            isolation_level: 'serializable',
        },
        content: 'Isolation rules',
    };

    // Project only declared tenant_model, missing isolation_level
    const projectConfig = {
        attributes: {
            tenant_model: 'multi_tenant',
        },
    };

    const res = saveDeclaration({
        declaration: decl,
        projectConfig,
    });

    assert.equal(res.saved, true);
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].code, 'UNDECLARED_PROJECT_ATTRIBUTE');
    assert.equal(res.warnings[0].attribute, 'isolation_level');
    assert.match(res.warnings[0].message, /chưa khai/);
});

test('SCN-KB-15 (AC-KB-04-04): Content modified without incrementing version halts with VERSION_REQUIRED (0 writes)', () => {
    const prevDecl = {
        id: 'rule-unchanged-version',
        version: '2.0.0',
        content: 'First revision of rule body',
        content_hash: computeDeclarationHash('First revision of rule body'),
    };

    const newDecl = {
        id: 'rule-unchanged-version',
        version: '2.0.0', // Stale version
        content: 'Second revision with critical updates',
        content_hash: computeDeclarationHash('Second revision with critical updates'),
    };

    assert.throws(() => {
        saveDeclaration({
            declaration: newDecl,
            previousDeclaration: prevDecl,
        });
    }, (err) => {
        assert.equal(err.code, 'VERSION_REQUIRED');
        assert.equal(err.version, '2.0.0');
        return true;
    });
});

test('SCN-KB-25 (AC-KB-04-05): Exact unicode id / long id is preserved without implicit normalization', () => {
    const unicodeId = 'kiến-trúc-dịch-vụ-2026-🎯-v1.0';
    const decl = {
        id: unicodeId,
        version: '1.0.0',
        kind: 'architecture',
        content: 'Architecture doc',
    };

    const res = saveDeclaration({ declaration: decl });
    assert.equal(res.saved, true);
    assert.equal(res.declaration.id, unicodeId);
    // Codepoints preserved
    assert.deepEqual(
        Array.from(res.declaration.id),
        Array.from(unicodeId)
    );
});

test('SCN-KB-30 (AC-KB-04-06): Dangling override targeting missing or revoked declaration raises DANGLING_OVERRIDE', () => {
    const decl = {
        id: 'override-legacy',
        version: '1.0.0',
        kind: 'skill',
        overrides: 'shared/skills/legacy-agent.md@1.0.0',
        content: 'Replacement skill',
    };

    // Shared pool where target was revoked
    const pool = [
        {
            id: 'legacy-agent',
            zone: 'shared',
            path: 'skills/legacy-agent.md',
            version: '1.0.0',
            status: 'revoked',
        },
    ];

    assert.throws(() => {
        saveDeclaration({
            declaration: decl,
            declarations: pool,
        });
    }, (err) => {
        assert.equal(err.code, 'DANGLING_OVERRIDE');
        assert.match(err.message, /DANGLING_OVERRIDE/);
        return true;
    });
});
