import path from 'node:path';
import { initProfile, projectDraftForConsumer } from '@mu/harness-foundation/init-profile';
import { loadProject, saveProject } from '@mu/harness-foundation/project-registry';
import {
    ensureProductState,
    productStateDir,
    syncTenantsFromWorkspace,
    tenantsFile,
    loadWorkspace,
    saveWorkspace,
} from '@mu/harness-foundation/workspace';
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
        port: 8792,
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
        throw new Error('usage: init profile <consumer-path> [--plan] [--force] [--id <id>] [--name <name>] [--host-mode dual-ide|superset] [--project <console-project-id>]');
    }

    const consumerPath = path.resolve(positional[0]);
    let project;
    if (opts.fromConsoleProject) {
        project = loadProject(productStateDir(), opts.fromConsoleProject);
        if (!project) throw new Error(`console project not found: ${opts.fromConsoleProject}`);
        project.agentRepo = { ...project.agentRepo, root: consumerPath };
    } else {
        project = projectDraftForConsumer(consumerPath, opts);
    }

    const result = initProfile(project, profilesDir(), tenantsFile(), {
        dryRun: opts.dryRun,
        force: opts.force,
    });

    if (!opts.dryRun) {
        const workspace = loadWorkspace();
        const row = {
            id: project.id,
            displayName: project.displayName,
            root: result.root,
            rootHost: result.root,
            port: project.observe?.port || 8792,
            profile: 'generic-eso',
            initProfile: true,
        };
        const idx = workspace.projects.findIndex((p) => p.id === project.id);
        if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
        else workspace.projects.push(row);
        workspace.defaultProjectId = workspace.defaultProjectId || project.id;
        saveWorkspace(workspace);
        syncTenantsFromWorkspace(workspace);

        if (opts.fromConsoleProject) {
            project.status = 'provisioned';
            project.provisionedAt = new Date().toISOString();
            saveProject(productStateDir(), project);
        }
    }

    return result;
}
