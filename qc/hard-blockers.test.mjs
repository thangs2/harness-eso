import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

test('tenant findings become blockers, and the marked exception stays out', () => {
    const { blockers } = hardBlockersFromChecks({
        tenant: {
            tenantTables: ['orders'],
            files: [
                { file: 'q.sql', content: 'select * from orders;' },
                { file: 'global.sql', content: 'select * from orders /* tenant:global */;' },
            ],
        },
    });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].source, 'tenant');
    assert.equal(blockers[0].kind, 'query-without-tenant');
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
    assert.deepEqual(checked, { contract: 0, tenant: 0, migration: 0 });
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

test('tenant without tables refuses to check anything and says why', () => {
    const root = workspace();
    const loaded = loadCheckInputs(root, { tenant: { files: ['q.sql'] } });
    assert.equal(loaded.tenant, null);
    assert.equal(loaded.errors[0].source, 'tenant');
    assert.match(loaded.errors[0].detail, /tenant\.tables is required/);
});

test('declared inputs are read from the root and become blockers end to end', () => {
    const root = workspace();
    write(root, 'migrations/001.sql', 'drop table orders;');
    write(root, 'queries/q.sql', 'select * from orders;');

    const loaded = loadCheckInputs(root, {
        tenant: { files: ['queries/q.sql'], tables: ['orders'] },
        migration: { files: ['migrations/001.sql'] },
    });
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.migration.files[0].file, 'migrations/001.sql');

    const { blockers } = hardBlockersFromChecks(loaded);
    assert.deepEqual(blockers.map((b) => b.source), ['tenant', 'migration']);
});

test('blockers attach to a live result and a skipped preflight stays skipped', () => {
    const result = { skipped: false, verdict: { sufficiency: { level: 'sufficient' } } };
    const attached = withHardBlockers(result, [{ source: 'migration', kind: 'drop-table', ref: 'a.sql', detail: 'x' }], []);
    assert.equal(attached.hardBlockers.length, 1);
    assert.equal(attached.verdict, result.verdict, 'the verdict is carried, not recomputed');

    assert.deepEqual(withHardBlockers({ skipped: true }, [{}], []), { skipped: true });
});

test('strict rejection also denies when a declared check could not be read (B1)', () => {
    const unreadable = { hardBlockers: [], checkErrors: [{ source: 'tenant', detail: 'nope' }] };
    assert.equal(rejectOnHardBlockers(unreadable), false);
    assert.equal(rejectOnHardBlockers(unreadable, { strict: true }), true);
    assert.equal(rejectOnHardBlockers({ hardBlockers: [{}] }), true);
    assert.equal(rejectOnHardBlockers(null), false);
});
