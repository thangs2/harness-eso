// X24 only counts CREATE TABLE inside sdlc/07.technical — so product code could create a table the data
// design never agreed to, and every check stayed green. It happened: ESO-484 provisioned `project` into
// the `graph` schema while 02.schema §3 assigns `project` to `cp` (D-73). A design that only lives in a
// file cannot be "ahead" of code; this check makes the file the gate.
//
// Scope is deliberate, not silent: the repo also ships `harness.db` (SQLite, documented in
// docs/03.state-and-contracts/02.data-model.md) and tables whose data-design family is not written yet.
// Those are listed in OUT_LEDGER with a reason and an open id — an exception you must type is a decision;
// an exception the checker skips is exactly the drift this file exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, 'sdlc/07.technical/02.data-design');
const read = (p) => readFileSync(p, 'utf8');

/** Tables that exist in product code but belong to a design family that is not written yet. */
const OUT_LEDGER = new Map([
    ['capability_pin', 'IAM/RBAC — data-design family chưa viết; `OPEN-IAM-DATA-01`'],
    ['provider_audit', 'IAM/RBAC — data-design family chưa viết; `OPEN-IAM-DATA-01`'],
    ['config_record', 'control-plane `cp` config — chưa đăng ký trong §2; `OPEN-CP-DATA-01`'],
    ['schema_migrations', 'harness.db (SQLite observe) — thiết kế ở docs/03.state-and-contracts/02.data-model.md, không thuộc ESO data-design'],
]);

/** Files a table may be created in: product code, not tests, not build output. */
function productFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
            productFiles(abs, out);
            continue;
        }
        if (!/\.(mjs|cjs|js|ts)$/.test(name)) continue;
        if (/\.test\./.test(name) || /\.d\.ts$/.test(name)) continue;
        out.push(abs);
    }
    return out;
}

/** `CREATE TABLE [IF NOT EXISTS] name` — this repo does not schema-qualify table names in DDL. */
function tablesCreated(text) {
    return [...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/g)].map((m) => m[1]);
}

const schema = read(join(DESIGN, '02.schema.md'));

/** §2 rows are the closed register: `| 12 | `role_preset` | ... |` */
const registered = new Set(
    [...schema.matchAll(/^\| \d+ \| `([a-z_][a-z0-9_]*)` \|/gm)].map((m) => m[1]),
);

/** §3 is the database assignment; the table cell is column 2, the reason column must not be read. */
const byDatabase = new Map();
for (const m of schema.matchAll(/^\| \*\*`(cp|ctx|graph)`\*\* \|(.+)$/gm)) {
    const tableCell = m[2].split('|')[0];
    byDatabase.set(m[1], new Set([...tableCell.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((x) => x[1])));
}

test('every table created in ESO product code is registered, or declared OUT with a reason', () => {
    const unexplained = [];
    for (const file of productFiles(join(ROOT, 'eso'))) {
        for (const table of tablesCreated(read(file))) {
            if (registered.has(table) || OUT_LEDGER.has(table)) continue;
            unexplained.push(`${relative(ROOT, file)} → ${table}`);
        }
    }
    assert.deepEqual(unexplained, [], 'a table exists only in code and is neither designed nor declared OUT');
    for (const [table, reason] of OUT_LEDGER) {
        assert.ok(reason.length > 20, `OUT_LEDGER entry ${table} needs a real reason and an open id`);
    }
});

test('graph code creates exactly the graph database’s tables, not one more', () => {
    const graphSet = byDatabase.get('graph');
    assert.ok(graphSet, '§3 must assign a `graph` database');
    assert.equal(graphSet.size, 6, `§3 graph should list 6 tables, saw ${graphSet.size}`);

    const graphFiles = productFiles(join(ROOT, 'eso/graph'));
    // The provisioner applies the graph DDL, so it is graph-scoped even though it lives in foundation.
    graphFiles.push(join(ROOT, 'packages/harness-foundation/src/graph-storage.mjs'));

    const created = new Set();
    for (const file of graphFiles) for (const t of tablesCreated(read(file))) created.add(t);

    assert.deepEqual(
        [...created].sort(),
        [...graphSet].sort(),
        'code and design disagree on what the graph database holds — D-73 says cp holds identity (project) ' +
            'and graph holds topology; a table in the wrong database is a second source of truth',
    );
});

test('the register and the database assignment cover the same tables', () => {
    const assigned = [...byDatabase.values()].flatMap((s) => [...s]);
    assert.deepEqual(
        [...new Set(assigned)].sort(),
        [...registered].sort(),
        'a table is registered without a database, or assigned to a database without being registered',
    );
});
