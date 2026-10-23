import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveEsoPolicy } from '../packages/harness-eso-core/src/eso-policy.mjs';
import { buildTurnVerdict } from '../packages/harness-eso-core/src/gate.mjs';
import { createDshEsoPlugin } from '../packages/harness-host-dsh/src/plugin.mjs';
import { policyWithNativeMemory } from './fixtures/host-runtime-fixture.mjs';

import {
    hardBlockersFromChecks,
    hasHardBlockers,
    loadCheckInputs,
    rejectOnHardBlockers,
    withHardBlockers,
} from '../packages/harness-eso-core/src/hard-blockers.mjs';

function workspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blockers-'));
}

function write(root, rel, body) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
}

test('a breaking contract change is a blocker named by path, not a score', () => {
    const { blockers } = hardBlockersFromChecks({
        contract: {
            before: { paths: { '/orders': { get: { responses: { 200: { schema: { type: 'object' } } } } } } },
            after: { paths: {} },
        },
    });
    assert.equal(blockers.length, 1);
    assert.deepEqual(blockers[0], {
        source: 'contract',
        kind: 'path-removed',
        ref: '/orders',
        detail: 'the whole path is gone',
    });
});

test('project findings become blockers, and the marked exception stays out', () => {
    const { blockers } = hardBlockersFromChecks({
        project: {
            scopedTables: ['orders'],
            files: [
                { file: 'q.sql', content: 'select * from orders;' },
                { file: 'global.sql', content: 'select * from orders /* isolation:global */;' },
            ],
        },
    });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].source, 'project');
    assert.equal(blockers[0].kind, 'query-without-caller');
    assert.equal(blockers[0].ref, 'q.sql');
    assert.equal(blockers[0].table, 'orders');
});

test('migration findings become blockers, and an approved statement is not one', () => {
    const { blockers } = hardBlockersFromChecks({
        migration: {
            files: [
                { file: 'a.sql', content: 'drop table orders;' },
                { file: 'b.sql', content: 'alter table orders drop column legacy /* breaking:approved */;' },
            ],
        },
    });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].kind, 'drop-table');
    assert.equal(blockers[0].ref, 'a.sql');
});

test('nothing declared is no blockers, and no silent pass is invented', () => {
    const { blockers, checked } = hardBlockersFromChecks({});
    assert.deepEqual(blockers, []);
    assert.deepEqual(checked, { contract: 0, project: 0, migration: 0 });
    assert.equal(hasHardBlockers({ hardBlockers: blockers }), false);
});

test('an unreadable path is an error, not a silent pass', () => {
    const root = workspace();
    const loaded = loadCheckInputs(root, { migration: { files: ['missing.sql'] } });
    assert.equal(loaded.errors.length, 1);
    assert.equal(loaded.errors[0].source, 'migration');
    assert.match(loaded.errors[0].detail, /cannot read missing\.sql/);
    assert.equal(loaded.migration.files.length, 0);
});

test('project without tables refuses to check anything and says why', () => {
    const root = workspace();
    const loaded = loadCheckInputs(root, { project: { files: ['q.sql'] } });
    assert.equal(loaded.project, null);
    assert.equal(loaded.errors[0].source, 'project');
    assert.match(loaded.errors[0].detail, /project\.tables is required/);
});

test('declared inputs are read from the root and become blockers end to end', () => {
    const root = workspace();
    write(root, 'migrations/001.sql', 'drop table orders;');
    write(root, 'queries/q.sql', 'select * from orders;');

    const loaded = loadCheckInputs(root, {
        project: { files: ['queries/q.sql'], tables: ['orders'] },
        migration: { files: ['migrations/001.sql'] },
    });
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.migration.files[0].file, 'migrations/001.sql');

    const { blockers } = hardBlockersFromChecks(loaded);
    assert.deepEqual(blockers.map((b) => b.source), ['project', 'migration']);
});

test('blockers attach to a live result and a skipped preflight stays skipped', () => {
    const result = { skipped: false, verdict: { sufficiency: { level: 'sufficient' } } };
    const attached = withHardBlockers(result, [{ source: 'migration', kind: 'drop-table', ref: 'a.sql', detail: 'x' }], []);
    assert.equal(attached.hardBlockers.length, 1);
    assert.equal(attached.verdict, result.verdict, 'the verdict is carried, not recomputed');

    assert.deepEqual(withHardBlockers({ skipped: true }, [{}], []), { skipped: true });
});

test('strict rejection also denies when a declared check could not be read (B1)', () => {
    const unreadable = { hardBlockers: [], checkErrors: [{ source: 'project', detail: 'nope' }] };
    assert.equal(rejectOnHardBlockers(unreadable), false);
    assert.equal(rejectOnHardBlockers(unreadable, { strict: true }), true);
    assert.equal(rejectOnHardBlockers({ hardBlockers: [{}] }), true);
    assert.equal(rejectOnHardBlockers(null), false);
});

test('a blocker closes the write channel even when sufficiency says sufficient', () => {
    const blocker = { source: 'migration', kind: 'drop-table', ref: '001.sql', detail: 'x' };
    const base = {
        requestId: 'r1',
        phase: 'preflight',
        measure: { level: 'sufficient', score: 1 },
        gaps: [],
        eso: { mode: 'hint', enforceWrites: 'off', cognition: {} },
        stem: 'ship it',
    };
    const clean = buildTurnVerdict(base);
    assert.equal(clean.allowProtectedWrite, true);
    assert.deepEqual(clean.hardBlockers, []);

    const blocked = buildTurnVerdict({ ...base, blockers: [blocker] });
    assert.equal(blocked.allowProtectedWrite, false);
    assert.equal(blocked.allowPromptSubmit, true, 'stopping the whole step is the host decision, not the engine\'s');
    assert.deepEqual(blocked.hardBlockers, [blocker]);
});

test('the DSH preflight carries the blocker into the verdict before the guard reads it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blockers-dsh-'));
    write(root, '001.sql', 'drop table orders;');
    const plugin = createDshEsoPlugin({
        root,
        policy: policyWithNativeMemory(),
        checks: { migration: { files: ['001.sql'] } },
        searchEvents: async () => [],
        law: false,
    });
    const result = await plugin.preflight({ event: 'turn_start', userQueryStem: 'ship it' });
    assert.equal(result.skipped, false);
    assert.equal(result.verdict.allowProtectedWrite, false);
    assert.equal(result.verdict.hardBlockers.length, 1);
    assert.equal(result.verdict.hardBlockers[0].kind, 'drop-table');
    assert.equal(result.hardBlockers.length, 1, 'the preflight result carries the same list');
});

test('without a declared check the verdict keeps its old shape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blockers-plain-'));
    const plugin = createDshEsoPlugin({
        root,
        policy: policyWithNativeMemory(),
        searchEvents: async () => [],
        law: false,
    });
    const result = await plugin.preflight({ event: 'turn_start', userQueryStem: 'ship it' });
    assert.deepEqual(result.verdict.hardBlockers, []);
});

test('a consumer can declare checks in policy, and invalid entries are dropped with the shape intact', () => {
    const resolved = resolveEsoPolicy({
        eso: {
            checks: {
                contract: { before: 'a.json', after: 'b.json' },
                project: { files: ['q.sql'], tables: ['orders', ''] },
                migration: { files: ['001.sql'] },
            },
        },
    });
    assert.deepEqual(resolved.checks, {
        contract: { before: 'a.json', after: 'b.json', direction: 'response' },
        project: { files: ['q.sql'], tables: ['orders'] },
        migration: { files: ['001.sql'] },
    });

    // Invalid entries disappear instead of throwing on the preflight path.
    const partial = resolveEsoPolicy({
        eso: { checks: { project: { files: ['q.sql'] }, contract: { before: 'a.json' } } },
    });
    assert.equal(partial.checks, null);

    assert.equal(resolveEsoPolicy({ eso: {} }).checks, null);
});

test('checks from eso.checks drive the DSH verdict without being passed to the plugin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blockers-policy-'));
    write(root, '001.sql', 'drop table orders;');
    const policy = policyWithNativeMemory();
    policy.eso.checks = { migration: { files: ['001.sql'] } };
    const plugin = createDshEsoPlugin({ root, policy, searchEvents: async () => [], law: false });

    const result = await plugin.preflight({ event: 'turn_start', userQueryStem: 'ship it' });
    assert.equal(result.verdict.allowProtectedWrite, false);
    assert.equal(result.verdict.hardBlockers[0].ref, '001.sql');
});

test('an explicit checks option wins over the policy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-blockers-wins-'));
    write(root, 'from-policy.sql', 'drop table orders;');
    write(root, 'from-option.sql', 'create table orders (id integer);');
    const policy = policyWithNativeMemory();
    policy.eso.checks = { migration: { files: ['from-policy.sql'] } };
    const plugin = createDshEsoPlugin({
        root,
        policy,
        checks: { migration: { files: ['from-option.sql'] } },
        searchEvents: async () => [],
        law: false,
    });

    const result = await plugin.preflight({ event: 'turn_start', userQueryStem: 'ship it' });
    assert.deepEqual(result.verdict.hardBlockers, [], 'the specific declaration replaces the policy one');
});
