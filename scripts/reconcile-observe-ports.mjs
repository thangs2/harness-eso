/**
 * Reconcile the two port registries after the one-owner fix (invariant A1).
 *
 * `workspace.json` owns ports; a Console project document records the same number for display. Before
 * the fix the document also defaulted to `8792` and nothing reconciled it, so
 * `~/.harness/projects/baplatform.json` said 8792 while the workspace said 8793 — and whichever process
 * read the document first addressed x79's stack.
 *
 * This repairs that state once. It is not a migration framework: run it, check the report, deploy.
 *
 *   node scripts/reconcile-observe-ports.mjs           # report only
 *   node scripts/reconcile-observe-ports.mjs --apply   # write the workspace's port into each document
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, productStateDir } from '@mu/harness-foundation/workspace';
import { claimObservePort, composeProjectName, normalizePort } from '@mu/harness-foundation/observe-port';

/**
 * Ports recorded on more than one project. `portsInUse` cannot answer this — it collapses to one entry
 * per id — so the check walks the rows directly.
 */
function duplicatePorts(ws) {
    const byPort = new Map();
    for (const p of ws.projects ?? []) {
        const port = normalizePort(p.port);
        if (port === null) continue;
        byPort.set(port, [...(byPort.get(port) ?? []), p.id]);
    }
    return [...byPort.entries()].filter(([, ids]) => ids.length > 1);
}

const apply = process.argv.includes('--apply');
const ws = loadWorkspace();
const stateDir = productStateDir();
const projectsDir = path.join(stateDir, 'projects');

function readDoc(id) {
    const file = path.join(projectsDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return { file, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const rows = [];
for (const row of ws.projects ?? []) {
    const owned = claimObservePort(ws, row.id);
    const found = readDoc(row.id);
    rows.push({
        id: row.id,
        workspacePort: owned,
        documentPort: found?.doc?.observe?.port ?? null,
        file: found?.file ?? '(no project document)',
        stack: composeProjectName(row.id),
    });
}

const conflicts = duplicatePorts(ws);
const divergent = rows.filter((r) => r.documentPort !== null && r.documentPort !== r.workspacePort);

console.log(`product state: ${stateDir}`);
console.log('');
for (const r of rows) {
    const mark = r.documentPort === null ? ' ' : r.documentPort === r.workspacePort ? '✔' : '✗';
    console.log(
        `${mark} ${r.id.padEnd(14)} workspace :${r.workspacePort}  document ${
            r.documentPort === null ? '(none)' : `:${r.documentPort}`
        }  stack ${r.stack}`,
    );
}

if (conflicts.length) {
    console.log('');
    console.log('Duplicate ports in the workspace (two projects cannot own one):');
    for (const [port, ids] of conflicts) console.log(`  :${port} ← ${ids.join(', ')}`);
}

if (!divergent.length) {
    console.log('');
    console.log('Document ports agree with the workspace. Nothing to reconcile.');
    process.exit(conflicts.length ? 1 : 0);
}

console.log('');
console.log(`${divergent.length} document port(s) disagree with the workspace:`);
for (const r of divergent) console.log(`  ${r.id}: document :${r.documentPort} → workspace :${r.workspacePort}`);

if (!apply) {
    console.log('');
    console.log('Re-run with --apply to write the workspace port into these documents.');
    process.exit(1);
}

for (const r of divergent) {
    const found = readDoc(r.id);
    if (!found) continue;
    found.doc.observe = { ...(found.doc.observe || {}), port: r.workspacePort, source: 'workspace' };
    found.doc.updatedAt = new Date().toISOString();
    fs.writeFileSync(found.file, `${JSON.stringify(found.doc, null, 4)}\n`);
    console.log(`  wrote ${found.file}`);
}

const stillOff = rows.filter((r) => {
    const found = readDoc(r.id);
    return found && found.doc.observe?.port !== r.workspacePort;
});
if (stillOff.length) {
    console.error(`reconcile incomplete: ${stillOff.map((r) => r.id).join(', ')}`);
    process.exit(1);
}
console.log('');
console.log('Reconciled. Restart each stack so it binds the registered port:');
for (const r of rows) console.log(`  harnessctl observatory restart --project ${r.id}`);
