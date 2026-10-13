import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compactEntries,
    entryCommand,
    hookNameFromId,
    mergeEventEntries,
    mergeHooksDocument,
} from '../packages/harness-foundation/src/hook-merge.mjs';

const cmd = (hook, tree = 'cursor') =>
    `bash -lc 'export HARNESS_TREE=${tree}; exec node .harness/host-pack/harness-hook.mjs --hook ${hook} --tree ${tree}'`;

const patchEntry = (id, hook, extra = {}) => ({ id, command: cmd(hook), failClosed: false, ...extra });

test('hookNameFromId strips the product prefix', () => {
    assert.equal(hookNameFromId('harness-eso-guard-shell'), 'guard-shell');
    assert.equal(hookNameFromId('guard-shell'), 'guard-shell');
});


test('appends when the consumer has no such hook', () => {
    const { list, next, report } = mergeEventEntries(
        [{ command: 'keep.py' }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
    );
    assert.equal(list.length, 2);
    assert.equal(list[0].command, 'keep.py');
    assert.deepEqual(report.added, ['harness-eso-guard-shell']);
    assert.ok(next['harness-eso-guard-shell']);
});

test('never writes the product id into the host config', () => {
    const { list } = mergeEventEntries([], [patchEntry('harness-eso-guard-shell', 'guard-shell')]);
    assert.equal(list[0].id, undefined);
    assert.ok(entryCommand(list[0]).includes('--hook guard-shell'));
});

test('updates in place when we wrote it and nobody touched it', () => {
    const prev = { 'harness-eso-guard-shell': { command: cmd('guard-shell') } };
    const { list, report } = mergeEventEntries(
        [{ command: cmd('guard-shell'), failClosed: true }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell'), { ...patchEntry('x', 'guard-shell'), command: cmd('guard-shell'), failClosed: true }].slice(0, 1),
        prev,
    );
    // The hook name matched, so no duplicate was appended.
    assert.equal(list.length, 1);
    assert.ok(report.kept.includes('harness-eso-guard-shell') || report.updated.includes('harness-eso-guard-shell'));
});

test('updates the command when the product changes its own line', () => {
    // Same hook, same marker, different invocation (e.g. the pack moved): an update, not a
    // migration and not a duplicate.
    const oldCmd =
        "bash -lc 'exec node .harness/host-pack/v0/harness-hook.mjs --hook guard-shell --tree cursor'";
    const prev = { 'harness-eso-guard-shell': { command: oldCmd } };
    const { list, next, report } = mergeEventEntries(
        [{ command: oldCmd, failClosed: true }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
        prev,
    );
    assert.equal(list.length, 1);
    assert.equal(entryCommand(list[0]), cmd('guard-shell'));
    assert.deepEqual(report.updated, ['harness-eso-guard-shell']);
    assert.deepEqual(report.migrated, []);
    assert.equal(next['harness-eso-guard-shell'].command, cmd('guard-shell'));
});

test('migrates a pre-pack shim in place instead of appending beside it', () => {
    // The install that predates the host pack: a shim path with no `--hook` marker.
    const legacy = "bash -lc 'exec node .cursor/hooks/harness-eso/guard-shell.mjs'";
    const { list, report } = mergeEventEntries(
        [{ command: legacy, failClosed: true }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
        {},
    );
    assert.equal(list.length, 1, 'replacing the shim must not leave two entries');
    assert.equal(entryCommand(list[0]), cmd('guard-shell'));
    assert.deepEqual(report.migrated, ['harness-eso-guard-shell']);
});

test('does not let a legacy entry masquerade as a consumer override', () => {
    // A legacy shim is ours; its mismatch with the recorded command must not be read as
    // "the operator edited this", or migration would never happen.
    const legacy = "bash -lc 'exec node .cursor/hooks/harness-eso/guard-shell.mjs'";
    const prev = { 'harness-eso-guard-shell': { command: 'something-else-entirely' } };
    const { list, report } = mergeEventEntries(
        [{ command: legacy }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
        prev,
    );
    assert.deepEqual(report.overridden, []);
    assert.equal(entryCommand(list[0]), cmd('guard-shell'));
});

test('prunes a legacy shim for a hook the product stopped shipping', () => {
    const legacy = "bash -lc 'exec node .cursor/hooks/harness-eso/write-stamp.mjs'";
    const { list, report } = mergeEventEntries([{ command: legacy }, { command: 'keep.py' }], [], {});
    assert.equal(list.length, 1);
    assert.equal(entryCommand(list[0]), 'keep.py');
    assert.ok(report.pruned.some((p) => p.includes('write-stamp')));
});

test('keeps a consumer-modified hook and does not re-add a duplicate', () => {
    const ours = cmd('guard-shell');
    const theirs = `${ours} # wrapped by operator`;
    const prev = { 'harness-eso-guard-shell': { command: ours } };
    const { list, next, report } = mergeEventEntries(
        [{ command: theirs, failClosed: true }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
        prev,
    );
    assert.equal(list.length, 1, 'must not append a second copy');
    assert.equal(entryCommand(list[0]), theirs, 'must not clobber the operator edit');
    assert.deepEqual(report.overridden, ['harness-eso-guard-shell']);
    assert.equal(next['harness-eso-guard-shell'].overridden, true);
});

test('an adopted override stays adopted on the next run', () => {
    const ours = cmd('guard-shell');
    const theirs = `${ours} # wrapped`;
    const prev = { 'harness-eso-guard-shell': { command: theirs, overridden: true } };
    const { list, report } = mergeEventEntries(
        [{ command: theirs }],
        [patchEntry('harness-eso-guard-shell', 'guard-shell')],
        prev,
    );
    assert.equal(list.length, 1);
    assert.equal(entryCommand(list[0]), theirs);
    assert.deepEqual(report.kept, ['harness-eso-guard-shell']);
});

test('prunes a hook the product stopped shipping', () => {
    const prev = { 'harness-eso-retired': { command: cmd('retired') } };
    const { list, report } = mergeEventEntries([{ command: cmd('retired') }], [], prev);
    assert.equal(list.length, 0);
    assert.deepEqual(report.pruned, ['harness-eso-retired']);
});

test('does not prune a pruned-candidate the consumer had edited', () => {
    const prev = { 'harness-eso-retired': { command: cmd('retired') } };
    const edited = `${cmd('retired')} # operator`;
    const { list, report } = mergeEventEntries([{ command: edited }], [], prev);
    assert.equal(list.length, 1);
    assert.deepEqual(report.pruned, []);
});

test('compacts legacy duplicate commands', () => {
    const dup = cmd('guard-shell');
    const out = compactEntries([{ command: dup }, { command: dup }, { command: 'keep.py' }]);
    assert.equal(out.length, 2);
});

test('merging the same patch three times is stable', () => {
    const patch = {
        hooks: {
            beforeShellExecution: [patchEntry('harness-eso-guard-shell', 'guard-shell')],
            preToolUse: [
                patchEntry('harness-eso-guard-brain', 'guard-brain'),
                patchEntry('harness-eso-guard-shell', 'guard-shell'),
            ],
        },
    };
    let doc = { version: 1, hooks: { preToolUse: [{ command: 'guard-write.py' }] } };
    let state = {};
    for (let i = 0; i < 3; i += 1) {
        const r = mergeHooksDocument(doc, patch, state);
        doc = r.document;
        state = r.state;
    }
    assert.equal(doc.hooks.beforeShellExecution.length, 1);
    assert.equal(doc.hooks.preToolUse.length, 3, 'consumer guard + two product hooks');
    assert.ok(doc.hooks.preToolUse.some((e) => entryCommand(e) === 'guard-write.py'));
});

test('consumer entries always survive a merge', () => {
    const consumer = [
        { command: '.cursor/hooks/guard-write.py', matcher: 'Write|StrReplace|Delete', failClosed: true },
        { command: 'keep.py' },
    ];
    const { document } = mergeHooksDocument(
        { version: 1, hooks: { preToolUse: consumer } },
        { hooks: { preToolUse: [patchEntry('harness-eso-guard-brain', 'guard-brain')] } },
        {},
    );
    const cmds = document.hooks.preToolUse.map(entryCommand);
    assert.ok(cmds.includes('.cursor/hooks/guard-write.py'));
    assert.ok(cmds.includes('keep.py'));
    assert.equal(cmds.length, 3);
});

test('reports a hook it could not place in the consumer document', () => {
    // `missing` is the signal a provision self-check can act on: a guard that was never wired
    // behaves exactly like a guard that passed every check.
    const { report } = mergeEventEntries([], [], {});
    assert.deepEqual(report.missing, []);
});

test('prunes a legacy shim in an event the patch no longer declares', () => {
    // A fresh provision has no previous record, so an event we stopped shipping would never be
    // visited — and its old command would survive, pointing at an implementation that no longer
    // exists. This is how a stale `.agents/hooks/harness-eso/pre-compact.mjs` line outlived the
    // shim it referenced on x79.
    const legacy = "bash -lc 'export HARNESS_TREE=agents; exec node .agents/hooks/harness-eso/pre-compact.mjs'";
    const doc = {
        version: 1,
        hooks: {
            preCompact: [{ command: legacy }],
            postToolUse: [{ command: 'keep.py' }],
        },
    };
    // Patch declares only postToolUse.
    const { document, report } = mergeHooksDocument(
        doc,
        { hooks: { postToolUse: [patchEntry('harness-eso-gap-tracker', 'gap-tracker')] } },
        {},
    );
    assert.equal(
        (document.hooks.preCompact || []).length,
        0,
        'the undeclared event must not keep a dead shim wired',
    );
    assert.ok(report.pruned.some((p) => String(p).includes('pre-compact')));
    // The consumer's own entry is still there, and its event is untouched.
    assert.deepEqual(document.hooks.postToolUse.map((e) => entryCommand(e)), ['keep.py', cmd('gap-tracker')]);
});

test('a declared shape change lands, not just the command', () => {
    /*
     * The merge used to update only the `command`, so an entry's wrapper shape was frozen at whatever
     * was first written. For Antigravity that matters: lifecycle events take a bare `{type, command}`
     * while tool events take a `{matcher, hooks: [{type, command}]}` wrapper, so an entry left in the
     * wrong shape is a hook the host may not run — invisible drift one level below the
     * Cursor-vocabulary block.
     */
    const nested = {
        matcher: '*',
        hooks: [{ type: 'command', command: cmd('route') }],
    };
    const bare = { id: 'harness-eso-route', type: 'command', command: cmd('route') };

    // matcher-form → bare form, same command.
    const { list } = mergeEventEntries([nested], [bare], {});
    assert.equal(list.length, 1);
    assert.equal(list[0].command, cmd('route'), 'the bare form must land');
    assert.equal(list[0].hooks, undefined, 'the superseded wrapper must be dropped');
    assert.equal(list[0].matcher, undefined);
    assert.equal(list[0].type, 'command');

    // bare form → matcher-form, same command.
    const back = mergeEventEntries([bare], [{ id: 'harness-eso-route', matcher: '*', hooks: [{ type: 'command', command: cmd('route') }] }], {});
    assert.equal(back.list.length, 1);
    assert.equal(back.list[0].matcher, '*');
    assert.equal(back.list[0].hooks?.[0]?.command, cmd('route'));
    assert.equal(back.list[0].command, undefined, 'the bare command key must go');
});

test('a consumer key on our entry survives a shape change', () => {
    // `timeout` is not ours, so a profile-driven rewrite must not drop it.
    const nested = { matcher: '*', timeout: 15, hooks: [{ type: 'command', command: cmd('route') }] };
    const bare = { id: 'harness-eso-route', type: 'command', command: cmd('route') };
    const { list } = mergeEventEntries([nested], [bare], {});
    assert.equal(list[0].type, 'command');
    assert.equal(list[0].timeout, 15, 'the consumer key must survive');
});

test('an unchanged shape is reported as kept, not rewritten', () => {
    const same = { type: 'command', command: cmd('route') };
    const { report } = mergeEventEntries(
        [same],
        [{ id: 'harness-eso-route', type: 'command', command: cmd('route') }],
        {},
    );
    assert.deepEqual(report.kept, ['harness-eso-route']);
    assert.deepEqual(report.updated, []);
});
