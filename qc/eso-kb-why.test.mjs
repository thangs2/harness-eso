import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveDeclarations,
    explainKnowledgeResolution,
    guardDeclarationWrite,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-04 (AC-KB-02-01): Selected declaration records from zone (project/shared/pool)', () => {
    const decls = [
        { id: 'skill-lint', kind: 'skill', path: 'skills/lint.md', version: '1.0', zone: 'shared', status: 'current' },
    ];

    const exp = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-lint',
    });

    assert.equal(exp.selected, true);
    assert.equal(exp.from, 'shared');
    assert.equal(exp.reason, 'matched');
});

test('SCN-KB-05 (AC-KB-02-02): Unselected item provides explicit reason why not selected', () => {
    const decls = [
        {
            id: 'skill-sql',
            kind: 'skill',
            path: 'skills/sql.md',
            version: '1.0',
            zone: 'shared',
            status: 'current',
            applies_when: { paths: ['**/*.sql'] },
        },
        {
            id: 'skill-revoked',
            kind: 'skill',
            path: 'skills/old.md',
            version: '0.9',
            zone: 'shared',
            status: 'revoked',
        },
    ];

    // Unmatched path
    const exp1 = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-sql',
        context: { path: 'src/main.ts' },
    });
    assert.equal(exp1.selected, false);
    assert(exp1.reason.includes('applies_when_mismatch'));

    // Revoked status
    const exp2 = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-revoked',
    });
    assert.equal(exp2.selected, false);
    assert.equal(exp2.reason, 'status_revoked');
});

test('SCN-KB-06 (AC-KB-02-03): Project override wins and surfaces overridden_by path@version list', () => {
    const decls = [
        { id: 'rule-naming', kind: 'rule', path: 'rules/naming.md', version: '2.0', zone: 'project', project: 'p-alpha', status: 'current' },
        { id: 'rule-naming', kind: 'rule', path: 'rules/naming.md', version: '1.0', zone: 'shared', status: 'current' },
    ];

    const exp = explainKnowledgeResolution({
        project: 'p-alpha',
        declarations: decls,
        targetId: 'rule-naming',
    });

    assert.equal(exp.selected, true);
    assert.equal(exp.from, 'project');
    assert.deepEqual(exp.overridden_by, ['shared/rules/naming.md@1.0']);
});

test('SCN-KB-07 (AC-KB-02-04): Agent modifying applies_when is rejected with RULE_CHANGE_FORBIDDEN (0 changes)', () => {
    assert.throws(() => {
        guardDeclarationWrite({
          actor_role: 'agent',
          declaration: { id: 'skill-secret' },
          changes: { applies_when: { always: true } },
        });
    }, (err) => {
        assert.equal(err.code, 'RULE_CHANGE_FORBIDDEN');
        return true;
    });

    assert.throws(() => {
        guardDeclarationWrite({
          actor_role: 'agent-subagent',
        });
    }, (err) => {
        assert.equal(err.code, 'RULE_CHANGE_FORBIDDEN');
        return true;
    });
});

test('SCN-KB-21 (AC-KB-02-05 & ED1): 0 declarations match returns empty resolved [] with explanation, 0 errors', () => {
    const decls = [
        { id: 'skill-docker', kind: 'skill', path: 'skills/docker.md', zone: 'shared', status: 'current', applies_when: { paths: ['**/Dockerfile'] } },
    ];

    const exp = explainKnowledgeResolution({
        project: 'p-empty',
        declarations: decls,
        context: { path: 'README.md' },
    });

    assert.deepEqual(exp.resolved, []);
    assert.equal(exp.unmatched_count, 1);
    assert.equal(exp.unmatched[0].reason, 'paths_mismatch');
});

test('SCN-KB-22 (AC-KB-02-06 & AC-KB-02-07): Deterministic sorting and unmasking shared version upon override removal', () => {
    const sharedItem = { id: 'skill-test', kind: 'skill', path: 'skills/test.md', version: '1.2', zone: 'shared', status: 'current' };
    const projectItem = { id: 'skill-test', kind: 'skill', path: 'skills/test.md', version: '2.0', zone: 'project', project: 'p1', status: 'current' };

    // With override
    const res1 = resolveDeclarations({ project: 'p1', declarations: [projectItem, sharedItem] });
    assert.equal(res1[0].from, 'project');
    assert.equal(res1[0].version, '2.0');

    // Override removed -> unmasks shared item currently active
    const res2 = resolveDeclarations({ project: 'p1', declarations: [sharedItem] });
    assert.equal(res2.length, 1);
    assert.equal(res2[0].from, 'shared');
    assert.equal(res2[0].version, '1.2');
});
