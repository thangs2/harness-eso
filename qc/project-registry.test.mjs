import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    WORKSPACE_VERSION,
    addProjectEntry,
    loadWorkspace,
    migrateProjectDocuments,
    productStateDir,
    updateProjectEntry,
    workspaceFile,
} from '../packages/harness-foundation/src/workspace-store.mjs';

/**
 * Registry v2: one file.
 *
 * v1 kept a project in `workspace.json` (id/root/port/profile) and `projects/<id>.json`
 * (status/plugins/hostMode/observe.port). Both were written, both were read, and they disagreed:
 * `/api/projects` listed 2 projects on this machine while `/api/observe-ports` listed 4, and a
 * project's `agentRepo.root` was empty in one place and correct in the other. These tests pin the
 * fold that removes the second file, and the reading path that made the disagreement visible.
 */

function withStateDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-registry-'));
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = dir;
    t.after(() => {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

function writeLegacyDoc(stateDir, doc) {
    const dir = path.join(stateDir, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 4));
}

function writeV1Workspace(stateDir, projects, extra = {}) {
    fs.writeFileSync(
        workspaceFile(),
        JSON.stringify({ version: 1, defaultProjectId: projects[0]?.id ?? null, projects, ...extra }, null, 4),
    );
}

test('a legacy project document is folded into the registry row', (t) => {
    const state = withStateDir(t);
    writeV1Workspace(state, [
        { id: 'beta', displayName: 'beta', root: '/w/beta', rootHost: '/w/beta', port: 8793, profile: 'generic-eso' },
    ]);
    writeLegacyDoc(state, {
        version: 1,
        id: 'beta',
        status: 'provisioned',
        agentRepo: { root: '/w/beta' },
        observe: { port: 8792 },
        plugins: { jev: { adapterId: 'jev-typesafe-active', mode: 'active' } },
        hostMode: 'all-ide',
    });

    const report = migrateProjectDocuments();
    assert.equal(report.migrated, true);
    assert.equal(report.folded, 1);

    const ws = loadWorkspace();
    assert.equal(ws.version, WORKSPACE_VERSION);
    const beta = ws.projects.find((p) => p.id === 'beta');
    // The document's fields survive…
    assert.equal(beta.status, 'provisioned');
    assert.equal(beta.hostMode, 'all-ide');
    assert.equal(beta.plugins.jev.mode, 'active');
    // …and the claimed port wins, because it is the number the compose stack already binds.
    assert.equal(beta.observe.port, 8793);

    assert.equal(fs.existsSync(path.join(state, 'projects')), false, 'the folded folder is removed');
});

test('a project only the document knew is adopted, not dropped', (t) => {
    const state = withStateDir(t);
    writeV1Workspace(state, [{ id: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', port: 8792 }]);
    // FinESO in the real case: registered by the Console, never reached workspace.json.
    writeLegacyDoc(state, { id: 'fineso', status: 'provisioned', agentRepo: { root: '/w/FinESO' }, observe: { port: 8794 } });

    const report = migrateProjectDocuments();
    assert.equal(report.adopted, 1);

    const ws = loadWorkspace();
    assert.deepEqual(
        ws.projects.map((p) => p.id).sort(),
        ['alpha', 'fineso'],
    );
    const fineso = ws.projects.find((p) => p.id === 'fineso');
    assert.equal(fineso.observe.port, 8794, 'an adopted project keeps its port');
    assert.equal(fineso.root, '/w/FinESO', 'an adopted project keeps its root');
});

test('an unreadable document keeps the legacy folder instead of being deleted', (t) => {
    const state = withStateDir(t);
    writeV1Workspace(state, [{ id: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', port: 8792 }]);
    const dir = path.join(state, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');

    const report = migrateProjectDocuments();
    assert.equal(report.broken.length, 1);
    assert.equal(report.removed, false);
    assert.equal(fs.existsSync(dir), true, 'a file we could not read is not thrown away');
});

test('migration is idempotent: a second load rewrites nothing', (t) => {
    const state = withStateDir(t);
    writeV1Workspace(state, [{ id: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', port: 8792 }]);
    migrateProjectDocuments();
    const first = fs.readFileSync(workspaceFile(), 'utf8');
    const report = migrateProjectDocuments();
    assert.equal(report.migrated, false);
    assert.equal(fs.readFileSync(workspaceFile(), 'utf8'), first);
});

test('updateProjectEntry writes the document in place, without a second file', (t) => {
    const state = withStateDir(t);
    writeV1Workspace(state, [{ id: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', port: 8792 }]);
    addProjectEntry({ id: 'gamma', root: '/w/gamma', rootHost: '/w/gamma', observe: { port: 8795 } });

    const next = updateProjectEntry('gamma', { status: 'provisioned', plugins: { jev: { mode: 'active' } } });
    assert.equal(next.status, 'provisioned');

    const reread = loadWorkspace().projects.find((p) => p.id === 'gamma');
    assert.equal(reread.plugins.jev.mode, 'active');
    assert.equal(reread.observe.port, 8795, 'a patch that omits the port does not erase it');
    assert.equal(fs.existsSync(path.join(state, 'projects')), false);
    assert.equal(productStateDir(), state);
});
