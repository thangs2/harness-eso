import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runHostConformance } from '../packages/harness-eso-core/src/conformance.mjs';
import { createDshSkillsLaw } from '../packages/harness-host-dsh/src/law-provider.mjs';
import { createDshEsoPlugin } from '../packages/harness-host-dsh/src/plugin.mjs';
import { policyWithNativeMemory } from './fixtures/host-runtime-fixture.mjs';

/**
 * A tree shaped like the Codex substrate's `materialise()` output — `AGENTS.md`, `.agents/skills/**`,
 * `sub_agents/**`, `scripts/**`, `.codex/` — which is also the tree Harness² edits. ESO should read it
 * without a second provider, and should be able to guard it without the guard being editable.
 */
function harnessTree({ hooksInEditable = false, surface = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness2-tree-'));
    const write = (rel, body) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    };

    write(
        'AGENTS.md',
        ['# Workspace rules', '', '- Run the deploy checklist before touching a migration.', '- Prefer a script over prose.'].join('\n'),
    );
    write(
        '.agents/skills/deploy/SKILL.md',
        ['# Deploy checklist', '', '1. Run the deploy checklist against staging.', '2. Read the rollback plan.'].join('\n'),
    );
    write(
        'sub_agents/reviewer/AGENT.md',
        ['---', 'description: reviews a diff before merge', '---', '', 'Review the diff for tenant filters before you approve it.'].join('\n'),
    );
    write('scripts/check_schema.py', 'print("schema ok")\n');

    // ESO's own hook pack, installed where the Codex substrate looks for hooks.
    write('.harness/host-pack/harness-hook.mjs', '// pack\n');
    write(
        '.codex/hooks.json',
        JSON.stringify({
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash',
                        hooks: [
                            {
                                type: 'command',
                                command: 'node .harness/host-pack/harness-hook.mjs --hook guard-shell --tree codex',
                            },
                        ],
                    },
                ],
            },
        }),
    );
    write('.codex/session/.eso-preflight.json', JSON.stringify({ level: 'sufficient', at: '2026-10-21T10:00:00Z' }));
    write('.codex/session/route-trace.jsonl', '{"event":"preInvocation"}\n');
    write('harness.config.json', JSON.stringify({ version: 1, project: { id: 'opt' } }));

    if (surface) {
        const editable = ['AGENTS.md', '.agents/skills/**', 'sub_agents/**'];
        if (hooksInEditable) editable.push('.codex/hooks.json');
        write('harness.config.json', JSON.stringify({ version: 1, project: { id: 'opt' }, harnessSurface: { surfaces: [{ id: 'codex', editable }] } }));
    }
    return root;
}

test('a skill in an optimized tree is law evidence with a real file and line', async () => {
    const root = harnessTree();
    const provider = createDshSkillsLaw({ root });
    const { snippets, trace } = await provider.fetch({ text: 'deploy checklist' });

    assert.match(trace, /^dsh-skills:\d+$/);
    assert.ok(snippets.length >= 1);
    const skill = snippets.find((s) => s.provenance.file === '.agents/skills/deploy/SKILL.md');
    assert.ok(skill, `expected the skill in ${snippets.map((s) => s.provenance.file).join(', ')}`);
    assert.equal(typeof skill.provenance.line, 'number');
    assert.ok(skill.provenance.line >= 1);
    assert.ok(skill.confidence <= 0.5, 'skills are curated instructions, not a normative corpus');
});

test('a delegated agent role is law too, because a model reads it before acting', async () => {
    const root = harnessTree();
    const { snippets } = await createDshSkillsLaw({ root }).fetch({ text: 'tenant filters review' });
    const role = snippets.find((s) => s.provenance.file === 'sub_agents/reviewer/AGENT.md');
    assert.ok(role, `expected the subagent role in ${snippets.map((s) => s.provenance.file).join(', ')}`);
});

test('the probe reports the tree as a native law provider', () => {
    const root = harnessTree();
    const policy = policyWithNativeMemory();
    policy.eso.sources.law = { enabled: true, prefer: ['native'], fallback: ['none'] };

    const rows = createDshEsoPlugin({ root, policy, searchEvents: async () => [] }).probe();
    const law = rows.find((row) => row.kind === 'law');
    assert.equal(law.selected.capability, 'native');
    assert.equal(law.selected.id, 'native:dsh-skills');
});

test('the tree is conformant when the gate lives outside the editable surface', () => {
    const report = runHostConformance(harnessTree());
    assert.equal(report.tierReached, 'H3');
    assert.equal(report.tiers.find((t) => t.id === 'H5').status, 'pass');
    assert.equal(report.ok, true);
});

test('the same tree fails H5 the moment an optimizer may edit the hook config', () => {
    const report = runHostConformance(harnessTree({ hooksInEditable: true }));
    const h5 = report.tiers.find((t) => t.id === 'H5');
    assert.equal(h5.status, 'fail');
    assert.equal(report.surface.violations[0].kind, 'gate-in-editable-surface');
    assert.equal(report.ok, false, 'the wiring still passes H0-H3; the trust does not');
});
