import path from 'node:path';
import { initProfile, projectDraftForConsumer } from '@mu/harness-foundation/init-profile';
import { loadProject, saveProject } from '@mu/harness-foundation/project-registry';
import {
    ensureProductState,
    productStateDir,
    syncProjectsFromWorkspace,
    registryFile,
    loadWorkspace,
    saveWorkspace,
} from '@mu/harness-foundation/workspace';
import { assignObservePort, normalizePort } from '@mu/harness-foundation/observe-port';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';

function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.join(ESO_ROOT, 'profiles');
}

/**
 * @param {string[]} argv after `init profile`
 */
export function runInitProfile(argv) {
    applyWorkspaceEnv();
    ensureProductState();

    const positional = [];
    const opts = {
        // No default port. A missing `--port` means "claim one from the workspace"; writing 8792 here
        // is what made every fresh consumer point at the first project's stack.
        port: null,
        hostMode: 'dual-ide',
        dryRun: false,
        force: false,
        projectId: null,
        displayName: null,
        hostProfile: null,
        fromConsoleProject: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--plan') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--id') opts.projectId = argv[++i];
        else if (a === '--name') opts.displayName = argv[++i];
        else if (a === '--port') opts.port = Number.parseInt(argv[++i], 10);
        else if (a === '--host-mode') opts.hostMode = argv[++i];
        else if (a === '--host-profile') opts.hostProfile = argv[++i];
        else if (a === '--project') opts.fromConsoleProject = argv[++i];
        else if (a.startsWith('-')) {
            throw new Error(`unknown flag: ${a}`);
        } else positional.push(a);
    }

    if (positional.length !== 1) {
        throw new Error('usage: init profile <consumer-path> [--plan] [--force] [--id <id>] [--name <name>] [--host-mode dual-ide|all-ide|claude|superset] [--project <console-project-id>]');
    }

    const consumerPath = path.resolve(positional[0]);
    const workspace = loadWorkspace();
    let project;
    if (opts.fromConsoleProject) {
        project = loadProject(productStateDir(), opts.fromConsoleProject);
        if (!project) throw new Error(`console project not found: ${opts.fromConsoleProject}`);
        project.agentRepo = { ...project.agentRepo, root: consumerPath };
    } else {
        project = projectDraftForConsumer(consumerPath, opts);
    }

    /*
     * The port is claimed before provisioning and written to **both** registries. The document used to
     * keep its own `observe.port` while the workspace kept another, and `initProfile` read whichever
     * one it was handed — so `harness.config.json`, `sidecar.env` and `host-bootstrap.json` could name
     * a number the registry never agreed to.
     */
    const port = assignObservePort(workspace, project.id, {
        preferred: normalizePort(opts.port),
    });
    project.observe = { ...(project.observe || {}), port };

    const result = initProfile(project, profilesDir(), registryFile(), {
        dryRun: opts.dryRun,
        force: opts.force,
        observePort: port,
    });

    if (!opts.dryRun) {
        const row = {
            id: project.id,
            displayName: project.displayName,
            root: result.root,
            rootHost: result.root,
            port,
            profile: 'generic-eso',
            initProfile: true,
        };
        const idx = workspace.projects.findIndex((p) => p.id === project.id);
        if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
        else workspace.projects.push(row);
        workspace.defaultProjectId = workspace.defaultProjectId || project.id;
        saveWorkspace(workspace);
        syncProjectsFromWorkspace(workspace);

        project.status = 'provisioned';
        project.provisionedAt = new Date().toISOString();
        saveProject(productStateDir(), project);
    }

    return result;
}
