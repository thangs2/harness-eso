/**
 * Report the state of the one project registry after the v2 merge (invariant A1).
 *
 * Until v2 a project lived in two files: the `workspace.json` row (`id`, `root`, `port`, `profile`)
 * and `projects/<id>.json` (`status`, `plugins`, `hostMode`, `observe.port`). Both were written by
 * hand and both were read by something, so they could disagree — `projects/baplatform.json` said
 * 8792 while the workspace said 8793, and whichever process read the document first addressed x79's
 * stack. The registry is now one file; `loadWorkspace()` folds any leftover `projects/` in on load.
 *
 * This script is what an operator runs when two answers still differ. It reports, and with
 * `--apply` it re-claims duplicate ports through the resolver instead of writing numbers by hand.
 *
 *   node scripts/reconcile-observe-ports.mjs           # report only
 *   node scripts/reconcile-observe-ports.mjs --apply   # re-claim ports that two projects share
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    LEGACY_PROJECTS_SUBDIR,
    loadWorkspace,
    migrateProjectDocuments,
    productStateDir,
    saveWorkspace,
    syncTenantsFromWorkspace,
    workspaceFile,
} from '@mu/harness-foundation/workspace';
import { assignObservePort, composeProjectName, normalizePort } from '@mu/harness-foundation/observe-port';

/**
 * Ports recorded on more than one project. `portsInUse` cannot answer this — it collapses to one
 * entry per id — so the check walks the rows directly.
 */
function duplicatePorts(ws) {
    const byPort = new Map();
    for (const p of ws.projects ?? []) {
        const port = normalizePort(p.observe?.port ?? p.port);
        if (port === null) continue;
        byPort.set(port, [...(byPort.get(port) ?? []), p.id]);
    }
    return [...byPort.entries()].filter(([, ids]) => ids.length > 1);
}

const apply = process.argv.includes('--apply');
const stateDir = productStateDir();
const migration = migrateProjectDocuments();
const ws = loadWorkspace();

console.log(`product state: ${stateDir}`);
console.log(`registry:      ${workspaceFile()}`);

if (migration.migrated) {
    console.log('');
    console.log('Migrated to registry v2:');
    if (migration.folded) console.log(`  folded ${migration.folded} project document(s) into the registry row`);
    if (migration.adopted) console.log(`  adopted ${migration.adopted} project(s) the workspace did not know`);
    if (migration.removed) console.log(`  removed ${path.join(stateDir, LEGACY_PROJECTS_SUBDIR)}/`);
    if (migration.broken?.length) {
        console.log(`  ${migration.broken.length} unreadable file(s) left in place:`);
        for (const f of migration.broken) console.log(`    ${f}`);
    }
} else if (fs.existsSync(path.join(stateDir, LEGACY_PROJECTS_SUBDIR))) {
    console.log('');
    console.log(`warning: ${path.join(stateDir, LEGACY_PROJECTS_SUBDIR)}/ still exists — unreadable files kept`);
}

console.log('');
for (const row of ws.projects ?? []) {
    const port = normalizePort(row.observe?.port ?? row.port);
    const status = row.status ?? 'draft';
    console.log(
        `${port === null ? ' ' : '✔'} ${String(row.id).padEnd(14)} :${
            port === null ? '(no port)' : port
        }  ${status.padEnd(12)} ${composeProjectName(row.id)}`,
    );
}

const conflicts = duplicatePorts(ws);
if (!conflicts.length) {
    console.log('');
    console.log('Every project owns a distinct port. Nothing to reconcile.');
    process.exit(0);
}

console.log('');
console.log('Duplicate ports in the registry (two projects cannot own one host port):');
for (const [port, ids] of conflicts) console.log(`  :${port} ← ${ids.join(', ')}`);

if (!apply) {
    console.log('');
    console.log('Re-run with --apply to re-claim ports for every owner after the first.');
    process.exit(1);
}

// Keep the first claimant and move the rest, through the resolver: it refuses a port that is taken
// and it records `source` so the next reader can tell an allocated number from a chosen one.
for (const [port, ids] of conflicts) {
    for (const id of ids.slice(1)) {
        const claimed = assignObservePort(ws, id);
        const row = ws.projects.find((p) => p.id === id);
        row.observe = { ...(row.observe || {}), port: claimed, source: 'reconcile' };
        row.port = claimed;
        row.updatedAt = new Date().toISOString();
        console.log(`  ${id}: :${port} → :${claimed}`);
    }
}
saveWorkspace(ws);
syncTenantsFromWorkspace(ws);

const after = duplicatePorts(loadWorkspace());
if (after.length) {
    console.error(`reconcile incomplete: ${after.map(([p, ids]) => `:${p} ${ids.join(',')}`).join(' ')}`);
    process.exit(1);
}
console.log('');
console.log('Reconciled. Restart each stack so it binds the registered port:');
for (const row of ws.projects) console.log(`  ./deploy.sh ${row.id}`);
