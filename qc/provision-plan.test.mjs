import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
    applyHostProfiles,
    buildProvisionPlan,
    policyFromProject,
    resolveHostProfileIds,
    provisionAction,
} from '@mu/harness-foundation/project-registry';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');

function draftProject(overrides = {}) {
    return {
        version: 1,
        id: 'qc-w9',
        displayName: 'QC W9',
        status: 'draft',
        agentRepo: { root: '' },
        observe: { port: 8792 },
        hostMode: 'dual-ide',
        plugins: {},
        ...overrides,
    };
}

test('resolveHostProfileIds dual-ide returns cursor + agents superset', () => {
    const ids = resolveHostProfileIds(draftProject({ hostMode: 'dual-ide' }));
    assert.deepEqual(ids, ['cursor-superset', 'agents-superset']);
});

test('resolveHostProfileIds rejects hostProfile none', () => {
    assert.throws(
        () =>
            resolveHostProfileIds(
                draftProject({ hostMode: 'superset', hostProfile: 'none' }),
            ),
        /not supported/,
    );
});

test('buildProvisionPlan dual-ide lists both IDE hook trees and preflight paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-'));
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    const rels = plan.files.map((f) => f.relative);

    // The pack is installed once for all IDEs; only the config that wires it is per-IDE.
    assert.ok(rels.includes('.harness/host-pack/'));
    assert.ok(rels.includes('.cursor/hooks.json'));
    assert.ok(rels.includes('.agents/hooks.json'));
    assert.ok(rels.includes('.cursor/session/.eso-preflight.json'));
    assert.ok(rels.includes('.agents/session/.eso-preflight.json'));

    const policy = plan.files.find((f) => f.relative === '.harness/decision-policy.json');
    assert.equal(policy?.preview?.eso?.preflight?.enabled, true);
});

test('applyHostProfiles dual-ide merges hooks.json on consumer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apply-'));
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.cursor', 'hooks.json'),
        JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'keep.py' }] } }, null, 2),
    );

    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    applyHostProfiles(root, plan.hostProfiles, {
        observePort: 8792, verify: false,
    });

    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
    assert.ok(
        (hooks.hooks.beforeSubmitPrompt || []).some((h) =>
            String(h.command).includes('--hook preflight'),
        ),
    );
    // One pack, no per-IDE copies of the implementation.
    assert.ok(fs.existsSync(path.join(root, '.harness', 'host-pack', 'harness-hook.mjs')));
    assert.ok(fs.existsSync(path.join(root, '.harness', 'host-pack', 'route-hook.py')));
    assert.equal(fs.existsSync(path.join(root, '.cursor', 'hooks', 'harness-eso')), false);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'hooks', 'harness-eso')), false);
});

test('applyHostProfiles is idempotent — re-running does not duplicate hooks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apply-twice-'));
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    for (let i = 0; i < 3; i += 1) {
        applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });
    }
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
    const count = (event, needle) =>
        (hooks.hooks[event] || []).filter((h) => String(h.command).includes(needle)).length;
    assert.equal(count('beforeSubmitPrompt', '--hook preflight'), 1);
    assert.equal(count('beforeSubmitPrompt', '--hook route'), 1);
    assert.equal(count('preToolUse', '--hook guard-brain'), 1);
    assert.equal(count('beforeShellExecution', '--hook guard-shell'), 1);
    assert.equal(count('postToolUse', '--hook route'), 1);
});

test('re-provision migrates legacy per-IDE shims to the pack, without leaving a duplicate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apply-compact-'));
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    // The pre-pack layout: a shim path with no `--hook` marker. It is duplicated because older
    // merges appended blindly, and it is dead weight because the shim spawned out of the checkout.
    const cmd = "bash -lc 'exec node .cursor/hooks/harness-eso/preflight.mjs'";
    fs.writeFileSync(
        path.join(root, '.cursor', 'hooks.json'),
        JSON.stringify({
            version: 1,
            hooks: {
                beforeSubmitPrompt: [
                    { command: cmd, failClosed: false },
                    { command: cmd, failClosed: false },
                    { command: cmd, failClosed: false },
                    { command: 'keep.py' },
                ],
            },
        }),
    );
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });

    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
    const list = hooks.hooks.beforeSubmitPrompt || [];
    // The legacy shim is gone — not kept alongside its replacement, which would run the hook twice
    // and execute a shim that no longer resolves.
    assert.equal(list.filter((h) => String(h.command) === cmd).length, 0);
    // Exactly one preflight entry now, the pack one.
    assert.equal(list.filter((h) => String(h.command).includes('--hook preflight')).length, 1);
    // The consumer's own hook is untouched.
    assert.ok(list.some((h) => String(h.command) === 'keep.py'));
});

test('re-provision prunes a legacy hook the product no longer ships', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apply-prune-'));
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    // `write-stamp` was removed from the pack; the old shim cannot run any more.
    fs.writeFileSync(
        path.join(root, '.cursor', 'hooks.json'),
        JSON.stringify({
            version: 1,
            hooks: {
                postToolUse: [
                    { command: "bash -lc 'exec node .cursor/hooks/harness-eso/write-stamp.mjs'" },
                    { command: 'keep.py' },
                ],
            },
        }),
    );
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });

    const list = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8')).hooks
        .postToolUse;
    assert.ok(
        !list.some((h) => String(h.command).includes('write-stamp')),
        'a dead legacy shim must not stay wired',
    );
    assert.ok(list.some((h) => String(h.command) === 'keep.py'));
});

test('buildProvisionPlan refuses an empty agentRepo.root instead of using cwd', () => {
    assert.throws(
        () => buildProvisionPlan(draftProject({ agentRepo: { root: '' } }), PROFILES_DIR, '/t.json'),
        /agentRepo\.root is required/,
    );
});

test('buildProvisionPlan refuses the harness-eso product repo as consumer', () => {
    assert.throws(
        () => buildProvisionPlan(draftProject({ agentRepo: { root: ESO_ROOT } }), PROFILES_DIR, '/t.json'),
        /not the harness-eso product repo/,
    );
});

test('provisionAction create-if-missing vs merge vs skip', () => {
    assert.equal(provisionAction('harness.config.json', false), 'create-if-missing');
    assert.equal(provisionAction('harness.config.json', true), 'skip');
    assert.equal(provisionAction('.harness/decision-policy.json', false), 'create-if-missing');
    assert.equal(provisionAction('.harness/decision-policy.json', true), 'merge');
    assert.equal(provisionAction('.harness/integrations.json', true), 'write');
});

test('provisionAction force rewrites only the anchor, never the policy', () => {
    assert.equal(provisionAction('harness.config.json', true, true), 'write');
    assert.equal(provisionAction('harness.config.json', false, true), 'create-if-missing');
    // decision-policy.json stays merge-only at any force level.
    assert.equal(provisionAction('.harness/decision-policy.json', true, true), 'merge');
});

test('buildProvisionPlan force flips the anchor action to write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-force-plan-'));
    const project = draftProject({ agentRepo: { root } });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'stale' }, registry: { registry: '~/.harness/registry.json' } }),
    );
    const plain = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    assert.equal(plain.files.find((f) => f.relative === 'harness.config.json')?.action, 'skip');

    const forced = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json', { force: true });
    assert.equal(forced.files.find((f) => f.relative === 'harness.config.json')?.action, 'write');
});

test('policyFromProject applies catalog policyPatch for Jev', () => {
    const catalog = JSON.parse(
        fs.readFileSync(path.join(PROFILES_DIR, 'plugin-catalog.json'), 'utf8'),
    );
    const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, 'generic-eso.json'), 'utf8'));
    const project = draftProject({
        plugins: {
            jev: { adapterId: 'jev-typesafe-shadow', mode: 'shadow' },
        },
    });
    const policy = policyFromProject(project, profile, catalog);
    assert.equal(policy.jev.mode, 'shadow');
});

test('antigravity hooks use AG-native event names and shapes, with no Cursor vocabulary', () => {
    /*
     * The agents tree must speak Antigravity's schema, and this used to fail that in two ways that
     * were invisible from the file alone:
     *
     *   1. the pack's hooks were written under a top-level `hooks` key with Cursor event names
     *      (`beforeSubmitPrompt`, `preToolUse`, …). AG reads named blocks with its own event names, so
     *      that entire block was inert — the guards it listed simply never ran.
     *   2. entries lacked `type: "command"`, which the working reference config includes.
     *
     * The shapes differ per event and both are load-bearing: AG takes a bare `{type, command}` for
     * lifecycle events (`PreInvocation`, `Stop`) and a `{matcher, hooks: [{type, command}]}` wrapper for
     * tool events (`PreToolUse`, `PostToolUse`).
     */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agy-route-'));
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'));

    // Cursor vocabulary must not appear anywhere in the Antigravity config.
    assert.equal(hooks.hooks, undefined, 'the Cursor-vocabulary `hooks` key must not be written');
    const flat = JSON.stringify(hooks);
    for (const cursorEvent of ['beforeSubmitPrompt', 'beforeShellExecution', 'preCompact', 'postToolUse']) {
        assert.ok(!flat.includes(cursorEvent), `${cursorEvent} is Cursor vocabulary, not AG`);
    }

    // Every block must use an AG event name, and every entry must carry `type: "command"`.
    const AG_EVENTS = ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
    const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
    let entries = 0;
    for (const [blockId, events] of Object.entries(hooks)) {
        if (blockId === 'version') continue;
        for (const [event, list] of Object.entries(events)) {
            assert.ok(AG_EVENTS.includes(event), `${blockId}/${event} is not an AG event name`);
            for (const entry of list) {
                if (TOOL_EVENTS.includes(event)) {
                    assert.ok(entry.matcher, `${blockId}/${event} needs a matcher`);
                    assert.ok(Array.isArray(entry.hooks) && entry.hooks.length, `${blockId}/${event} needs hooks[]`);
                    for (const h of entry.hooks) {
                        assert.equal(h.type, 'command');
                        assert.ok(String(h.command).length);
                        entries += 1;
                    }
                } else {
                    assert.equal(entry.type, 'command', `${blockId}/${event} must be a bare command entry`);
                    assert.ok(String(entry.command).length);
                    entries += 1;
                }
            }
        }
    }
    assert.ok(entries >= 7, `expected the full hook set, saw ${entries}`);

    // And the guard that matters most on this tree must be present.
    const wired = flat.match(/--hook ([a-z-]+)/g) || [];
    assert.ok(wired.includes('--hook guard-shell'), 'guard-shell must be wired for AG');
    assert.ok(hooks['harness-eso-route']?.PreInvocation?.length, 'route tracing must stay wired');
});

test('removing the flat hook set from a profile cleans up the consumer', () => {
    /*
     * A profile change that stops declaring a hook set has to clean up the consumer, otherwise the
     * stale entries stay wired forever. Same class as F22 (an event we no longer declare is never
     * visited): the `if (treeSpec.merge)` guard skipped the prune entirely, so Antigravity's config
     * kept a `hooks` block full of Cursor event names that AG never read.
     *
     * The simulation goes through the real code path in both directions — apply a profile that
     * declares flat hooks, then apply one that does not — because entries are pruned via the recorded
     * state, and hand-writing them into the file would make them indistinguishable from the
     * consumer's own (which the merge correctly leaves alone).
     */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-drop-'));
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');

    // 1. the old shape: the agents profile used to carry a Cursor-vocabulary `merge`.
    const legacy = plan.hostProfiles.map((p) =>
        p.id !== 'agents-superset'
            ? p
            : {
                  ...p,
                  agents: {
                      ...p.agents,
                      merge: {
                          beforeSubmitPrompt: [
                              {
                                  id: 'harness-eso-preflight',
                                  command:
                                      "bash -lc 'export HARNESS_TREE=agents; exec node .harness/host-pack/harness-hook.mjs --hook preflight --tree agents'",
                              },
                          ],
                      },
                  },
              },
    );
    applyHostProfiles(root, legacy, { observePort: 8792, verify: false });

    const hooksPath = path.join(root, '.agents', 'hooks.json');
    const before = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(before.hooks?.beforeSubmitPrompt?.length, 'the legacy shape must have been written');

    // 2. the new shape: no `merge` for this tree.
    applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });

    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(after.hooks, undefined, 'the stale Cursor-vocabulary block must be gone');
    assert.ok(after['harness-eso-route'], 'AG blocks must still be present');
});

test('a block dropped from the profile is removed from the consumer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-drop-block-'));
    const project = draftProject({ agentRepo: { root } });
    const plan = buildProvisionPlan(project, PROFILES_DIR, '/tmp/registry.json');
    applyHostProfiles(root, plan.hostProfiles, { observePort: 8792, verify: false });

    const hooksPath = path.join(root, '.agents', 'hooks.json');
    const doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    doc['harness-eso-retired'] = {
        Stop: [{ type: 'command', command: "bash -lc 'exec node .harness/host-pack/harness-hook.mjs --hook route --tree agents --event Stop'" }],
    };
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 4));

    const trimmed = plan.hostProfiles.map((p) => {
        if (p.id !== 'agents-superset') return p;
        const agy = { ...p.agents.agyMerge };
        delete agy['harness-eso-observe'];
        return { ...p, agents: { ...p.agents, agyMerge: agy } };
    });
    applyHostProfiles(root, trimmed, { observePort: 8792, verify: false });

    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(after['harness-eso-observe'], undefined, 'a block no longer declared must be removed');
    assert.ok(after['harness-eso-route'], 'the blocks still declared must survive');
});
