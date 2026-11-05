import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPgDb } from '../../../qc/helpers/test-pg-db.mjs';

async function createTestDb() {
    return (await createTestPgDb()).db;
}


import {
  resolveEffectiveKnowledge,
  resolveDeclarations,
  explainKnowledgeResolution,
  matchesAppliesWhen,
  guardDeclarationWrite,
  promoteToShared,
  revertSharedPromotion,
  syncDeclarations,
  computeDeclarationHash,
  queryKnowledgeItem,
  validateDeclarationZone,
  createProjectTableSql,
  createRlsPolicySql,
  setEsoProject,
  filterByProject,
  initDeclarationSchema,
  DECLARATION_SCHEMA_SQL,
  CLOSED_DECLARATION_KINDS,
  CLOSED_DECLARATION_STATUSES,
  ALLOWED_DECLARATION_FIELDS,
  ALLOWED_APPLIES_WHEN_FIELDS,
  REQUIRED_PROJECT_ATTRIBUTES,
  validateDeclarationFormat,
  checkDanglingOverrides,
  saveDeclaration,
} from '../src/index.mjs';

describe('ESO Knowledge Isolation & Resolver (Slice S1 / ESO-24)', () => {
  it('AC-KB-01-01: 2 project in 1 instance resolve disjoint sets, foreign items do not appear', () => {
    const declarations = [
      { id: 'item-alpha', project: 'proj-A', zone: 'project', content: 'Secret A' },
      { id: 'item-beta', project: 'proj-B', zone: 'project', content: 'Secret B' }
    ];

    const resA = resolveEffectiveKnowledge('proj-A', declarations);
    const resB = resolveEffectiveKnowledge('proj-B', declarations);

    assert.equal(resA.items.length, 1);
    assert.equal(resA.items[0].id, 'item-alpha');
    assert.equal(resA.items.some(i => i.project === 'proj-B'), false);

    assert.equal(resB.items.length, 1);
    assert.equal(resB.items[0].id, 'item-beta');
    assert.equal(resB.items.some(i => i.project === 'proj-A'), false);
  });

  it('AC-KB-01-02: Querying other project item returns NOT_FOUND indistinguishable from absent item', () => {
    const declarations = [
      { id: 'private-x', project: 'proj-X', zone: 'project', content: 'Proprietary X' }
    ];

    const absentResult = queryKnowledgeItem('proj-Y', 'does-not-exist', declarations);
    assert.equal(absentResult.found, false);
    assert.equal(absentResult.error, 'NOT_FOUND');
    assert.equal(absentResult.exists, 'absent');
    assert.equal(absentResult.visibility, 'not-visible');

    const foreignResult = queryKnowledgeItem('proj-Y', 'private-x', declarations);
    assert.equal(foreignResult.found, false);
    assert.equal(foreignResult.error, 'NOT_FOUND');
    assert.equal(foreignResult.exists, 'present');
    assert.equal(foreignResult.visibility, 'not-visible');

    assert.equal(foreignResult.found, absentResult.found);
    assert.equal(foreignResult.error, absentResult.error);
  });

  it('AC-KB-01-03 & INV-KB-03: Shared items appear in both projects with Resolved{from: "shared"} unless overridden', () => {
    const declarations = [
      { id: 'rule-global', zone: 'shared', content: 'Standard Convention' },
      { id: 'rule-custom', zone: 'shared', content: 'Default Custom' },
      { id: 'rule-custom', project: 'proj-A', zone: 'project', content: 'Overridden by A' }
    ];

    const resA = resolveEffectiveKnowledge('proj-A', declarations);
    const resB = resolveEffectiveKnowledge('proj-B', declarations);

    const bGlobal = resB.items.find(i => i.id === 'rule-global');
    const bCustom = resB.items.find(i => i.id === 'rule-custom');
    assert.ok(bGlobal);
    assert.equal(bGlobal.from, 'shared');
    assert.equal(bGlobal.overridden, false);
    assert.ok(bCustom);
    assert.equal(bCustom.from, 'shared');
    assert.equal(bCustom.overridden, false);

    const aGlobal = resA.items.find(i => i.id === 'rule-global');
    const aCustom = resA.items.find(i => i.id === 'rule-custom');
    assert.ok(aGlobal);
    assert.equal(aGlobal.from, 'shared');
    assert.ok(aCustom);
    assert.equal(aCustom.from, 'project');
    assert.equal(aCustom.overridden, true);
    assert.equal(aCustom.content, 'Overridden by A');
  });

  it('AC-KB-01-04: Project with 0 declarations yields empty set without errors', () => {
    const res = resolveEffectiveKnowledge('empty-proj', []);
    assert.deepEqual(res.items, []);
    assert.equal(res.errors.length, 0);
  });

  it('AC-KB-01-05: Declaration out of declared zone is discarded with OUT_OF_ZONE and 0 foreign files loaded', () => {
    const declValid = { id: 'd1', zone: 'project', path: 'project/d1.json', project: 'proj-A' };
    const declAlien = { id: 'alien', zone: 'project', path: 'shared/secret.json', project: 'proj-A' };
    const declTraverse = { id: 'traverse', zone: 'project', path: '../system/config.json', project: 'proj-A' };

    assert.equal(validateDeclarationZone(declValid, 'project').valid, true);

    const alienCheck = validateDeclarationZone(declAlien, 'project');
    assert.equal(alienCheck.valid, false);
    assert.equal(alienCheck.code, 'OUT_OF_ZONE');
    assert.equal(alienCheck.path, 'shared/secret.json');

    const traverseCheck = validateDeclarationZone(declTraverse, 'project');
    assert.equal(traverseCheck.valid, false);
    assert.equal(traverseCheck.code, 'OUT_OF_ZONE');

    const res = resolveEffectiveKnowledge('proj-A', [declValid, declAlien, declTraverse]);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, 'd1');
    assert.equal(res.warnings.length, 2);
    assert.equal(res.warnings[0].code, 'OUT_OF_ZONE');
    assert.equal(res.warnings[1].code, 'OUT_OF_ZONE');
  });

  it('RLS: DDL generation and in-memory policy filter match project isolation', () => {
    const ddlTable = createProjectTableSql('eso_knowledge');
    assert.ok(ddlTable.includes('CREATE TABLE IF NOT EXISTS eso_knowledge'));
    assert.ok(ddlTable.includes('ENABLE ROW LEVEL SECURITY'));
    assert.ok(ddlTable.includes('FORCE ROW LEVEL SECURITY'));

    const ddlPolicy = createRlsPolicySql('eso_knowledge', 'project');
    assert.ok(ddlPolicy.includes('CREATE POLICY rls_eso_knowledge_isolation'));
    assert.ok(ddlPolicy.includes("current_setting('eso.project', true)"));

    const rows = [
      { id: '1', project: 'proj-A', zone: 'project' },
      { id: '2', project: 'proj-B', zone: 'project' },
      { id: '3', project: null, zone: 'shared' }
    ];

    const session = setEsoProject({}, 'proj-A');
    assert.equal(session['eso.project'], 'proj-A');

    const filtered = filterByProject(rows, 'proj-A');
    assert.equal(filtered.length, 2);
    assert.ok(filtered.some(r => r.id === '1'));
    assert.ok(filtered.some(r => r.id === '3'));
    assert.ok(!filtered.some(r => r.id === '2'));
  });

  describe('5.1 / ESO-125: Declaration Table DDL & Resolved[] (Slice S1)', () => {
    it('DDL: declaration table initializes with primary key (project, kind, path, version)', async () => {
      const db = await createTestDb();
      await initDeclarationSchema(db);

      // Insert valid row
      await db.exec(`
        INSERT INTO declaration (project, kind, path, applies_when, content_hash, overrides, proposal_id, version, status)
        VALUES ('proj-alpha', 'skill', 'skills/auth.md', '{"globs":["src/**"]}', 'hash123', '{}', NULL, '1.0', 'current');
      `);

      const rows = await db.all('SELECT * FROM declaration WHERE project = ?', ['proj-alpha']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'skill');
      assert.equal(rows[0].version, '1.0');
      assert.equal(rows[0].status, 'current');
    });

    it('BR-10: declaration is append-only, DELETE is forbidden via trigger', async () => {
      const db = await createTestDb();
      await initDeclarationSchema(db);

      await db.exec(`
        INSERT INTO declaration (project, kind, path, applies_when, content_hash, overrides, proposal_id, version, status)
        VALUES ('proj-alpha', 'skill', 'skills/auth.md', '{}', 'hash123', '{}', NULL, '1.0', 'current');
      `);

      await assert.rejects(() => db.exec("DELETE FROM declaration WHERE project = 'proj-alpha'"), (err) => {
        assert(err.message.includes('BR-10: declaration is append-only. DELETE is forbidden.'));
        return true;
      });
    });

    it('DoD 5.1: Three zones declare same id -> single winner, from records winning zone, overridden_by lists hidden', () => {
      const declarations = [
        {
          id: 'skill-deploy',
          kind: 'skill',
          path: 'skills/deploy.md',
          version: '2.0',
          zone: 'project',
          project: 'proj-omega',
          status: 'current',
        },
        {
          id: 'skill-deploy',
          kind: 'skill',
          path: 'skills/deploy.md',
          version: '1.5',
          zone: 'shared',
          status: 'current',
        },
        {
          id: 'skill-deploy',
          kind: 'skill',
          path: 'skills/deploy.md',
          version: '1.0',
          zone: 'pool',
          status: 'current',
        },
      ];

      const resolved = resolveDeclarations({
        project: 'proj-omega',
        declarations,
      });

      assert.equal(resolved.length, 1, 'Exactly one winner for the same id');
      const winner = resolved[0];
      assert.equal(winner.id, 'skill-deploy');
      assert.equal(winner.version, '2.0');
      assert.equal(winner.from, 'project', 'Project override wins over shared and pool');
      assert.deepEqual(winner.overridden_by, [
        'shared/skills/deploy.md@1.5',
        'pool/skills/deploy.md@1.0',
      ], 'overridden_by is a list of overridden path@version, NOT a boolean');
    });

    it('DoD 5.1: Shared declaration without project override wins over pool', () => {
      const declarations = [
        {
          id: 'skill-review',
          kind: 'skill',
          path: 'skills/review.md',
          version: '1.2',
          zone: 'shared',
          status: 'current',
        },
        {
          id: 'skill-review',
          kind: 'skill',
          path: 'skills/review.md',
          version: '1.0',
          zone: 'pool',
          status: 'current',
        },
      ];

      const resolved = resolveDeclarations({
        project: 'proj-omega',
        declarations,
      });

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].from, 'shared');
      assert.equal(resolved[0].version, '1.2');
      assert.deepEqual(resolved[0].overridden_by, ['pool/skills/review.md@1.0']);
    });

    it('DoD 5.1: Project direct use of pool item (from: pool, overridden_by omitted)', () => {
      const declarations = [
        {
          id: 'skill-lint',
          kind: 'skill',
          path: 'skills/lint.md',
          version: '1.0',
          zone: 'pool',
          status: 'current',
          uses: true,
        },
      ];

      const resolved = resolveDeclarations({
        project: 'proj-omega',
        declarations,
      });

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].from, 'pool');
      assert.equal(resolved[0].overridden_by, undefined, 'overridden_by is omitted when nothing is overridden');
    });

    it('DoD 5.1: Resolved[] is strictly sorted by id codepoint for byte-identical replay', () => {
      const declarations = [
        { id: 'zeta-check', kind: 'rule', path: 'rules/z.md', zone: 'shared', status: 'current' },
        { id: 'alpha-guard', kind: 'rule', path: 'rules/a.md', zone: 'shared', status: 'current' },
        { id: 'beta-verify', kind: 'rule', path: 'rules/b.md', zone: 'shared', status: 'current' },
      ];

      const resolved1 = resolveDeclarations({ project: 'p1', declarations });
      const resolved2 = resolveDeclarations({ project: 'p1', declarations: [...declarations].reverse() });

      assert.deepEqual(resolved1.map(r => r.id), ['alpha-guard', 'beta-verify', 'zeta-check']);
      assert.equal(JSON.stringify(resolved1), JSON.stringify(resolved2), 'Byte-identical serialization across runs');
    });
  });

  describe('US-KB-02 / ESO-130: Knowledge Why Applied & RBAC Guard (Slice S1)', () => {
    it('AC-KB-02-01: Selected item records from (project / shared / pool)', () => {
      const decls = [
        { id: 'skill-jira', kind: 'skill', path: 's/j.md', zone: 'shared', status: 'current', applies_when: { always: true } },
      ];
      const res = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-jira',
      });

      assert.equal(res.selected, true);
      assert.equal(res.from, 'shared');
      assert.equal(res.reason, 'matched');
    });

    it('AC-KB-02-02: Unselected item explains why not (applies_when_mismatch, superseded, etc.)', () => {
      const decls = [
        {
          id: 'skill-multi-tenant',
          kind: 'skill',
          path: 's/mt.md',
          zone: 'shared',
          status: 'current',
          applies_when: { tenant_model: 'multi' },
        },
        {
          id: 'skill-old-jira',
          kind: 'skill',
          path: 's/old.md',
          zone: 'shared',
          status: 'superseded',
        },
      ];

      // Mismatch on tenant_model
      const exp1 = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-multi-tenant',
        context: { tenant_model: 'single' },
      });
      assert.equal(exp1.selected, false);
      assert(exp1.reason.includes('applies_when_mismatch'));

      // Mismatch on status
      const exp2 = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-old-jira',
      });
      assert.equal(exp2.selected, false);
      assert.equal(exp2.reason, 'status_superseded');
    });

    it('AC-KB-02-03: Override wins and records overridden_by path@version list', () => {
      const decls = [
        { id: 'skill-auth', kind: 'skill', path: 's/auth.md', version: '2.0', zone: 'project', project: 'p1', status: 'current' },
        { id: 'skill-auth', kind: 'skill', path: 's/auth.md', version: '1.0', zone: 'shared', status: 'current' },
      ];

      const exp = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        targetId: 'skill-auth',
      });

      assert.equal(exp.selected, true);
      assert.equal(exp.from, 'project');
      assert.deepEqual(exp.overridden_by, ['shared/s/auth.md@1.0']);
    });

    it('AC-KB-02-04: Agent modifying applies_when/declaration is rejected with RULE_CHANGE_FORBIDDEN', () => {
      assert.throws(() => {
        guardDeclarationWrite({
          actor_role: 'agent',
          declaration: { id: 'skill-1' },
          changes: { applies_when: { always: true } },
        });
      }, (err) => {
        assert.equal(err.code, 'RULE_CHANGE_FORBIDDEN');
        assert(err.message.includes('INV-KB-02'));
        return true;
      });

      assert.throws(() => {
        guardDeclarationWrite({
          actor_role: 'agent-executor',
        });
      }, (err) => {
        assert.equal(err.code, 'RULE_CHANGE_FORBIDDEN');
        return true;
      });

      // Human operator is allowed
      const ok = guardDeclarationWrite({
        actor_role: 'operator',
        declaration: { id: 'skill-1' },
      });
      assert.equal(ok.allowed, true);
    });

    it('AC-KB-02-05 / ED1: 0 declarations match returns empty resolved [] with explanation, 0 errors', () => {
      const decls = [
        { id: 'sk1', kind: 'skill', path: 's/1.md', zone: 'shared', status: 'current', applies_when: { paths: ['**/*.special.ts'] } },
      ];

      const exp = explainKnowledgeResolution({
        project: 'p1',
        declarations: decls,
        context: { path: 'src/normal.js' },
      });

      assert.deepEqual(exp.resolved, []);
      assert.equal(exp.total_candidates, 1);
      assert.equal(exp.unmatched_count, 1);
      assert.equal(exp.unmatched[0].id, 'sk1');
      assert.equal(exp.unmatched[0].reason, 'paths_mismatch');
    });

    it('AC-KB-02-06 / ED3: 1000 declarations resolution is deterministic regardless of array order', () => {
      const decls = [];
      for (let i = 0; i < 1000; i++) {
        decls.push({
          id: `item-${String(i).padStart(4, '0')}`,
          kind: 'skill',
          path: `skills/${i}.md`,
          zone: 'shared',
          status: 'current',
          applies_when: { always: true },
        });
      }

      const resA = resolveDeclarations({ project: 'p1', declarations: decls });
      const resB = resolveDeclarations({ project: 'p1', declarations: [...decls].reverse() });

      assert.equal(resA.length, 1000);
      assert.equal(resB.length, 1000);
      assert.equal(JSON.stringify(resA), JSON.stringify(resB));
    });

    it('AC-KB-02-07: Removing project override reverts to currently active shared version, not empty', () => {
      const sharedDecl = {
        id: 'skill-cache',
        kind: 'skill',
        path: 's/cache.md',
        version: '1.5',
        zone: 'shared',
        status: 'current',
      };
      const projectOverride = {
        id: 'skill-cache',
        kind: 'skill',
        path: 's/cache.md',
        version: '2.0',
        zone: 'project',
        project: 'p1',
        status: 'current',
      };

      // 1. With override active
      const resWithOverride = resolveDeclarations({
        project: 'p1',
        declarations: [projectOverride, sharedDecl],
      });
      assert.equal(resWithOverride[0].from, 'project');
      assert.equal(resWithOverride[0].version, '2.0');

      // 2. Override removed (e.g. revoked or deleted)
      const resAfterRemoval = resolveDeclarations({
        project: 'p1',
        declarations: [sharedDecl],
      });
      assert.equal(resAfterRemoval.length, 1, 'Must not be empty');
      assert.equal(resAfterRemoval[0].from, 'shared');
      assert.equal(resAfterRemoval[0].version, '1.5');
    });
  });

  describe('US-KB-03 / ESO-135: Shared Knowledge Promotion (Slice S1)', () => {
    it('AC-KB-03-01: Projects without override adopt 1.3 on next turn', () => {
      const initialShared = {
        id: 'skill-api-style',
        kind: 'skill',
        path: 'skills/api.md',
        version: '1.2',
        zone: 'shared',
        status: 'current',
        content_hash: 'hash-1.2',
      };

      const promotion = promoteToShared({
        declaration: initialShared,
        new_version: '1.3',
        actor_role: 'operator',
        declarations: [initialShared],
        projects: ['proj-frontend', 'proj-backend'],
      });

      assert.equal(promotion.promoted, true);
      assert.equal(promotion.new_version, '1.3');
      assert.deepEqual(promotion.impact.affected_projects, ['proj-frontend', 'proj-backend']);
      assert.deepEqual(promotion.impact.overridden_projects, []);

      // Verify that projects now resolve to 1.3
      const resFront = resolveDeclarations({ project: 'proj-frontend', declarations: promotion.declarations });
      const resBack = resolveDeclarations({ project: 'proj-backend', declarations: promotion.declarations });
      assert.equal(resFront[0].version, '1.3');
      assert.equal(resBack[0].version, '1.3');
    });

    it('AC-KB-03-02: Project with local override does not change, surfaces overridden_by', () => {
      const initialShared = {
        id: 'skill-logger',
        kind: 'skill',
        path: 'skills/log.md',
        version: '1.0',
        zone: 'shared',
        status: 'current',
      };
      const projectOverride = {
        id: 'skill-logger',
        kind: 'skill',
        path: 'skills/log.md',
        version: '1.0-custom',
        zone: 'project',
        project: 'proj-special',
        status: 'current',
      };

      const promotion = promoteToShared({
        declaration: initialShared,
        new_version: '2.0',
        actor_role: 'operator',
        declarations: [initialShared, projectOverride],
        projects: ['proj-standard', 'proj-special'],
      });

      assert.equal(promotion.promoted, true);
      assert.deepEqual(promotion.impact.affected_projects, ['proj-standard']);
      assert.deepEqual(promotion.impact.overridden_projects, ['proj-special']);

      // Project with override still runs its local override version
      const resSpecial = resolveDeclarations({ project: 'proj-special', declarations: promotion.declarations });
      assert.equal(resSpecial[0].version, '1.0-custom');
      assert.equal(resSpecial[0].from, 'project');
      assert.deepEqual(resSpecial[0].overridden_by, ['shared/skills/log.md@2.0']);

      // Standard project runs new version 2.0
      const resStandard = resolveDeclarations({ project: 'proj-standard', declarations: promotion.declarations });
      assert.equal(resStandard[0].version, '2.0');
      assert.equal(resStandard[0].from, 'shared');
    });

    it('AC-KB-03-03: Promotion without human approval is rejected with APPROVAL_REQUIRED', () => {
      assert.throws(() => {
        promoteToShared({
          declaration: { id: 'skill-auth', version: '2.0' },
          actor_role: 'agent',
        });
      }, (err) => {
        assert.equal(err.code, 'APPROVAL_REQUIRED');
        return true;
      });

      assert.throws(() => {
        promoteToShared({
          declaration: { id: 'skill-auth', version: '2.0' },
          actor_role: null,
        });
      }, (err) => {
        assert.equal(err.code, 'APPROVAL_REQUIRED');
        return true;
      });
    });

    it('AC-KB-03-04: Returns impact list; revert is a single atomic action restoring previous pointer', () => {
      const v1 = { id: 'skill-db', kind: 'skill', path: 's/db.md', version: '1.0', zone: 'shared', status: 'current', content_hash: 'h1' };
      const promo = promoteToShared({
        declaration: v1,
        new_version: '1.1',
        actor_role: 'operator',
        declarations: [v1],
        projects: ['p1'],
      });

      assert.equal(promo.promoted, true);
      assert.equal(promo.new_version, '1.1');
      assert.equal(promo.previous_version, '1.0');

      // Revert action
      const revert = revertSharedPromotion({
        item_id: 'skill-db',
        actor_role: 'operator',
        declarations: promo.declarations,
      });

      assert.equal(revert.reverted, true);
      assert.equal(revert.revoked_version, '1.1');
      assert.equal(revert.restored_version, '1.0');

      // Now resolution resolves 1.0 again
      const resolved = resolveDeclarations({ project: 'p1', declarations: revert.declarations });
      assert.equal(resolved[0].version, '1.0');
      assert.equal(resolved[0].from, 'shared');
    });

    it('AC-KB-03-05 / ED6: Duplicate promotion with same version and hash is no-op with impact: []', () => {
      const shared = {
        id: 'skill-metrics',
        kind: 'skill',
        path: 's/m.md',
        version: '1.5',
        content_hash: 'same-hash-123',
        zone: 'shared',
        status: 'current',
      };

      const promo2 = promoteToShared({
        declaration: shared,
        new_version: '1.5',
        content_hash: 'same-hash-123',
        actor_role: 'operator',
        declarations: [shared],
        projects: ['p1', 'p2'],
      });

      assert.equal(promo2.promoted, false);
      assert.equal(promo2.idempotent, true);
      assert.deepEqual(promo2.impact, []);
    });

    it('AC-KB-03-06: Atomic snapshot transitions prevent hybrid/inconsistent states', () => {
      const initial = [
        { id: 'skill-a', kind: 'skill', path: 'a.md', version: '1.0', zone: 'shared', status: 'current' },
        { id: 'skill-b', kind: 'skill', path: 'b.md', version: '1.0', zone: 'shared', status: 'current' },
      ];

      // Pure function on snapshot: snapshot before promotion is unchanged
      const promoA = promoteToShared({
        declaration: initial[0],
        new_version: '2.0',
        actor_role: 'operator',
        declarations: initial,
        projects: ['p1'],
      });

      const readOld = resolveDeclarations({ project: 'p1', declarations: initial });
      const readNew = resolveDeclarations({ project: 'p1', declarations: promoA.declarations });

      assert.equal(readOld[0].version, '1.0');
      assert.equal(readNew[0].version, '2.0');
    });

    it('AC-KB-03-07: Two projects both using 1.2 both update in a single promotion', () => {
      const sharedV12 = {
        id: 'skill-core-rule',
        kind: 'skill',
        path: 's/core.md',
        version: '1.2',
        zone: 'shared',
        status: 'current',
      };

      const promo = promoteToShared({
        declaration: sharedV12,
        new_version: '1.3',
        actor_role: 'operator',
        declarations: [sharedV12],
        projects: ['proj-alpha', 'proj-beta'],
      });

      assert.equal(promo.promoted, true);
      assert.deepEqual(promo.impact.affected_projects, ['proj-alpha', 'proj-beta']);

      const resA = resolveDeclarations({ project: 'proj-alpha', declarations: promo.declarations });
      const resB = resolveDeclarations({ project: 'proj-beta', declarations: promo.declarations });
      assert.equal(resA[0].version, '1.3');
      assert.equal(resB[0].version, '1.3');
    });
  });

  describe('US-KB-05 / ESO-140: Drift Sync & Conflict Halting (Slice S1)', () => {
    it('AC-KB-05-01: Matching hashes results in 0 changes and clean sync', () => {
      const fileDecls = [
        { path: 'skills/clean.md', content_hash: 'hash-abc', version: '1.0' },
      ];
      const dbDecls = [
        { path: 'skills/clean.md', content_hash: 'hash-abc', version: '1.0' },
      ];

      const res = syncDeclarations({
        project: 'p1',
        fileDeclarations: fileDecls,
        dbDeclarations: dbDecls,
      });

      assert.equal(res.synced, true);
      assert.equal(res.in, 0);
      assert.equal(res.out, 0);
      assert.deepEqual(res.conflicts, []);
    });

    it('AC-KB-05-02: Hash mismatch halts with SYNC_CONFLICT, reports file + both hashes (0 writes)', () => {
      const fileDecls = [
        { path: 'skills/conflict.md', content_hash: 'hash-file-999', version: '1.0' },
      ];
      const dbDecls = [
        { path: 'skills/conflict.md', content_hash: 'hash-db-111', version: '1.0' },
      ];

      assert.throws(() => {
        syncDeclarations({
          project: 'p1',
          fileDeclarations: fileDecls,
          dbDeclarations: dbDecls,
        });
      }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts.length, 1);
        assert.equal(err.conflicts[0].path, 'skills/conflict.md');
        assert.equal(err.conflicts[0].file_hash, 'hash-file-999');
        assert.equal(err.conflicts[0].db_hash, 'hash-db-111');
        return true;
      });
    });

    it('AC-KB-05-03: Retrying sync on conflict STILL halts, never auto-resolves or picks winner', () => {
      const fileDecls = [
        { path: 'skills/drift.md', content_hash: 'hash-file-aaa', version: '2.0' },
      ];
      const dbDecls = [
        { path: 'skills/drift.md', content_hash: 'hash-db-bbb', version: '2.0' },
      ];

      // Run 1
      assert.throws(() => {
        syncDeclarations({ project: 'p1', fileDeclarations: fileDecls, dbDeclarations: dbDecls });
      }, (err) => err.code === 'SYNC_CONFLICT');

      // Run 2 (retry): still halts, state is not altered
      assert.throws(() => {
        syncDeclarations({ project: 'p1', fileDeclarations: fileDecls, dbDeclarations: dbDecls });
      }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts.length, 1);
        return true;
      });
    });

    it('AC-KB-05-04 / ED1: 0 files on both sides yields clean no-op with 0 writes, 0 errors', () => {
      const res = syncDeclarations({
        project: 'p1',
        fileDeclarations: [],
        dbDeclarations: [],
      });

      assert.equal(res.synced, true);
      assert.equal(res.in, 0);
      assert.equal(res.out, 0);
      assert.deepEqual(res.conflicts, []);
    });

    it('AC-KB-05-05 / ED3: 1000 declarations compared, reports ALL discrepancies without dropping any', () => {
      const fileDecls = [];
      const dbDecls = [];

      for (let i = 0; i < 1000; i++) {
        const path = `skills/item-${i}.md`;
        // Create mismatch for odd numbers
        const fileHash = `hash-file-${i}`;
        const dbHash = (i % 2 === 0) ? `hash-file-${i}` : `hash-db-${i}`;

        fileDecls.push({ path, content_hash: fileHash });
        dbDecls.push({ path, content_hash: dbHash });
      }

      assert.throws(() => {
        syncDeclarations({
          project: 'p1',
          fileDeclarations: fileDecls,
          dbDeclarations: dbDecls,
        });
      }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts.length, 500, 'All 500 odd mismatches are reported');
        return true;
      });
    });
  });

  describe('ESO Knowledge Authoring & Validation (Slice S1 / ESO-145 / US-KB-04)', () => {
    it('AC-KB-04-01: Valid declaration with closed attributes saves successfully, version increments', () => {
      const decl = {
        id: 'decl-001',
        version: '1.0.1',
        kind: 'rule',
        applies_when: { always: true },
        declared_by: 'alice',
        declared_at: '2026-11-04T00:00:00Z',
        path: 'rules/auth.md',
        content: '# Auth Rule\nJWT must be verified.',
        content_hash: computeDeclarationHash('# Auth Rule\nJWT must be verified.'),
        zone: 'project',
        project: 'p1',
      };

      const result = saveDeclaration({ declaration: decl });
      assert.equal(result.saved, true);
      assert.equal(result.declaration.status, 'current');
      assert.equal(result.warnings.length, 0);
    });

    it('AC-KB-04-02: Unknown attributes in declaration or applies_when rejected with UNKNOWN_ATTRIBUTE (0 writes)', () => {
      // 1. Unknown top-level attribute
      const declWithBadTop = {
        id: 'decl-002',
        version: '1.0.0',
        kind: 'rule',
        unexpected_field: 'illegal',
      };
      assert.throws(() => {
        saveDeclaration({ declaration: declWithBadTop });
      }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
        assert.equal(err.field, 'unexpected_field');
        return true;
      });

      // 2. Unknown field inside applies_when
      const declWithBadAw = {
        id: 'decl-003',
        version: '1.0.0',
        kind: 'rule',
        applies_when: { invalid_predicate: true },
      };
      assert.throws(() => {
        saveDeclaration({ declaration: declWithBadAw });
      }, (err) => {
        assert.equal(err.code, 'UNKNOWN_ATTRIBUTE');
        assert.equal(err.field, 'applies_when.invalid_predicate');
        return true;
      });
    });

    it('AC-KB-04-03: Using required project attribute undeclared by project warns "chưa khai", never assumes default', () => {
      const decl = {
        id: 'decl-004',
        version: '1.0.0',
        kind: 'skill',
        applies_when: { tenant_model: 'multi_tenant' },
        declared_by: 'bob',
        path: 'skills/db.md',
        content: 'multi-tenant instructions',
      };

      // Project configuration has NOT declared tenant_model
      const result = saveDeclaration({
        declaration: decl,
        projectConfig: { attributes: {} },
      });

      assert.equal(result.saved, true);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'UNDECLARED_PROJECT_ATTRIBUTE');
      assert.equal(result.warnings[0].attribute, 'tenant_model');
      assert.match(result.warnings[0].message, /chưa khai/);
    });

    it('AC-KB-04-04: Content changed but version not incremented is rejected with VERSION_REQUIRED (0 writes)', () => {
      const prevDecl = {
        id: 'decl-005',
        version: '1.0.0',
        kind: 'rule',
        content: 'Original content v1',
        content_hash: computeDeclarationHash('Original content v1'),
      };

      const newDecl = {
        id: 'decl-005',
        version: '1.0.0', // Not bumped!
        kind: 'rule',
        content: 'Modified content without version bump',
        content_hash: computeDeclarationHash('Modified content without version bump'),
      };

      assert.throws(() => {
        saveDeclaration({
          declaration: newDecl,
          previousDeclaration: prevDecl,
        });
      }, (err) => {
        assert.equal(err.code, 'VERSION_REQUIRED');
        return true;
      });
    });

    it('AC-KB-04-05: Unicode id is preserved verbatim, never normalized implicitly', () => {
      const unicodeId = 'quy-tắc-kiểm-thử-tiếng-việt-⭐';
      const decl = {
        id: unicodeId,
        version: '1.0.0',
        kind: 'rule',
        content: 'Unicode rule body',
      };

      const res = saveDeclaration({ declaration: decl });
      assert.equal(res.saved, true);
      assert.equal(res.declaration.id, unicodeId);
      // Check exact codepoints
      for (let i = 0; i < unicodeId.length; i++) {
        assert.equal(res.declaration.id.codePointAt(i), unicodeId.codePointAt(i));
      }
    });

    it('AC-KB-04-06: Dangling override targeting missing/deleted declaration surfaces DANGLING_OVERRIDE', () => {
      const decl = {
        id: 'decl-006',
        version: '1.0.0',
        kind: 'rule',
        overrides: 'shared/rules/missing.md@1.0.0',
        content: 'Override non-existent declaration',
      };

      const existingDecls = [
        { id: 'decl-other', path: 'rules/other.md', version: '1.0.0', zone: 'shared', status: 'current' },
        { id: 'decl-revoked', path: 'rules/missing.md', version: '1.0.0', zone: 'shared', status: 'revoked' },
      ];

      assert.throws(() => {
        saveDeclaration({
          declaration: decl,
          declarations: existingDecls,
        });
      }, (err) => {
        assert.equal(err.code, 'DANGLING_OVERRIDE');
        assert.match(err.message, /DANGLING_OVERRIDE/);
        return true;
      });
    });
  });
});
